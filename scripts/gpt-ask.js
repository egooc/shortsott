// 세션들이 GPT(Codex CLI · ChatGPT Pro 구독 로그인)에 일을 맡기는 공용 창구. API 키는 쓰지 않는다.
//
//   node scripts/gpt-ask.js "질문"                          조사·검토 (웹 검색 켬, 파일 쓰기 금지)
//   node scripts/gpt-ask.js --file prompt.md                긴 지시는 파일로
//   node scripts/gpt-ask.js --attach a.png --attach b.png "이 컨택트 시트에서 자막 겹침 찾아"
//   node scripts/gpt-ask.js --image D:/out/thumb.png "남색 배경 …"   이미지 생성 → 그 경로에 저장
//   node scripts/gpt-ask.js --effort medium --no-search "…"
//   node scripts/gpt-ask.js --session "C 린박스" "…"       기록에 남길 호출자 이름
//
// 규칙
// - 한도·인증 오류가 나면 거기서 멈춘다. 다른 계정·다른 키로 넘어가지 않는다(정지 사유).
// - 동시에 4건까지 돈다(GPT_ASK_SLOTS 로 조정). 나머지는 자리가 날 때까지 기다린다(최대 20분).
//   동시 실행 수는 계정 제한이 아니라 이 PC 부하·사용량 배분용이다(소유주: 세션 여러 개 동시 가능 확인, 10-15).
// - 호출 기록: server/output/task-logs/gpt-ask.jsonl — 세션·소요시간·토큰(usage)·구독 한도 사용률(limits). 답 전문은 남기지 않는다.
// - 결과물은 참고 의견이다. 사실은 출처 URL로 다시 확인하고, 검수 답·측정값을 대신하지 않는다.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CODEX_JS = path.join(ROOT, 'tools/gpt-ask-cli/node_modules/@openai/codex/bin/codex.js');
const WORK = path.join(ROOT, 'tools/gpt-ask-work');
const LOG = path.join(ROOT, 'server/output/task-logs/gpt-ask.jsonl');
const SLOTS = Number(process.env.GPT_ASK_SLOTS) || 4;
const SLOT_WAIT_MS = 20 * 60 * 1000;
const TIMEOUT_MS = 30 * 60 * 1000;
// 인증은 GPT_ASK_CODEX_HOME(전용 로그인)이 있으면 그걸, 없으면 orca 의 Codex 로그인을 쓴다.
const CODEX_HOME = process.env.GPT_ASK_CODEX_HOME
  || process.env.CODEX_HOME
  || [path.join(os.homedir(), 'AppData/Roaming/orca/codex-runtime-home/home'), path.join(os.homedir(), '.codex')]
    .find((p) => fs.existsSync(path.join(p, 'auth.json')))
  || path.join(os.homedir(), '.codex');

function parseArgs(argv) {
  const o = { attach: [], effort: 'high', search: true, image: null, file: null, session: '', prompt: '' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--attach') o.attach.push(path.resolve(argv[++i]));
    else if (a === '--image') o.image = path.resolve(argv[++i]);
    else if (a === '--file') o.file = path.resolve(argv[++i]);
    else if (a === '--effort') o.effort = argv[++i];
    else if (a === '--session') o.session = argv[++i];
    else if (a === '--no-search') o.search = false;
    else if (a === '-h' || a === '--help') o.help = true;
    else rest.push(a);
  }
  o.prompt = [o.file ? fs.readFileSync(o.file, 'utf8') : '', rest.join(' ')].filter(Boolean).join('\n\n');
  return o;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function takeSlot() {
  fs.mkdirSync(WORK, { recursive: true });
  const start = Date.now();
  for (;;) {
    for (let i = 1; i <= SLOTS; i++) {
      const f = path.join(WORK, `slot${i}.lock`);
      try {
        fs.writeFileSync(f, String(process.pid), { flag: 'wx' });
        return f;
      } catch {
        const pid = Number(fs.readFileSync(f, 'utf8')) || 0;
        if (!pid || !pidAlive(pid)) { try { fs.unlinkSync(f); } catch {} }
      }
    }
    if (Date.now() - start > SLOT_WAIT_MS) throw new Error(`gpt-ask: 20분 기다려도 자리가 나지 않았다(동시 ${SLOTS}건). 나중에 다시 하라.`);
    await sleep(5000);
  }
}

function log(entry) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify(entry) + '\n', 'utf8');
}

// codex exec --json 의 turn.completed 에서 토큰 사용량을 모은다(턴이 여럿이면 합산).
function usageFromEvents(jsonl) {
  const u = { input: 0, cached: 0, output: 0, reasoning: 0, turns: 0 };
  for (const line of jsonl.split('\n')) {
    if (!line.includes('turn.completed')) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type !== 'turn.completed' || !ev.usage) continue;
      u.turns += 1;
      u.input += ev.usage.input_tokens || 0;
      u.cached += ev.usage.cached_input_tokens || 0;
      u.output += ev.usage.output_tokens || 0;
      u.reasoning += ev.usage.reasoning_output_tokens || 0;
    } catch {}
  }
  return u.turns ? u : null;
}

// 방금 끝난 세션 파일(CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl)에서 마지막 rate_limits 를 읽는다.
// used_percent 가 구독 한도 사용률이다(window_minutes 10080 = 주간, 300 = 5시간).
function rateLimitsFromSessions(sinceMs) {
  try {
    const d = new Date();
    const dir = path.join(CODEX_HOME, 'sessions', String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
    const files = fs.readdirSync(dir).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).mtimeMs >= sinceMs - 60000);
    let last = null;
    for (const f of files) {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        const i = line.indexOf('"rate_limits":');
        if (i < 0) continue;
        try { const ev = JSON.parse(line); const rl = ev.payload?.rate_limits || ev.rate_limits; if (rl) last = rl; } catch {}
      }
    }
    if (!last) return null;
    const pick = (w) => w ? { used_pct: w.used_percent, window_min: w.window_minutes, resets_at: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null } : null;
    return { plan: last.plan_type || null, primary: pick(last.primary), secondary: pick(last.secondary) };
  } catch { return null; }
}

const LIMIT_RE = /usage limit|rate limit|429|quota|token_revoked|401|unauthorized|refresh token/i;

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.prompt) {
    process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n') + '\n');
    process.exit(o.help ? 0 : 2);
  }
  if (!fs.existsSync(CODEX_JS)) throw new Error(`Codex CLI 가 없다: ${CODEX_JS} (npm i --prefix tools/gpt-ask-cli @openai/codex@0.162.1)`);

  fs.mkdirSync(WORK, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(WORK, 'run-'));
  const outFile = path.join(runDir, 'last.txt');
  let prompt = o.prompt;
  if (o.image) {
    fs.mkdirSync(path.dirname(o.image), { recursive: true });
    prompt += `\n\n[출력] 내장 이미지 생성 도구로 만들어라(코드로 그리지 마라). 결과 PNG 를 정확히 이 경로에 저장하라: ${o.image}\n저장한 뒤 경로 한 줄만 답하라. 도구가 없거나 거절되면 그 사유만 답하라.`;
  }

  const args = [CODEX_JS, 'exec', '--skip-git-repo-check', '--json',
    '-s', o.image ? 'workspace-write' : 'read-only',
    '-C', runDir,
    '-c', `model_reasoning_effort="${o.effort}"`,
    '-c', `web_search="${o.search ? 'live' : 'disabled'}"`,
    '-o', outFile];
  if (o.image) args.push('--add-dir', path.dirname(o.image));
  for (const a of o.attach) args.push('-i', a);
  args.push('-');

  const slot = await takeSlot();
  const t0 = Date.now();
  let stderr = '';
  let stdout = '';
  let code;
  try {
    code = await new Promise((resolve) => {
      const child = spawn(process.execPath, args, {
        cwd: runDir,
        env: { ...process.env, CODEX_HOME },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const timer = setTimeout(() => { stderr += '\n[gpt-ask] 30분 초과로 중단'; child.kill(); }, TIMEOUT_MS);
      child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
      child.stderr.on('data', (d) => { stderr += d.toString('utf8'); if (stderr.length > 200000) stderr = stderr.slice(-100000); });
      child.on('close', (c) => { clearTimeout(timer); resolve(c); });
      child.stdin.end(prompt, 'utf8');
    });
  } finally {
    try { fs.unlinkSync(slot); } catch {}
  }

  const usage = usageFromEvents(stdout);
  const limits = rateLimitsFromSessions(t0);
  const answer = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : '';
  const imageOk = o.image ? fs.existsSync(o.image) : undefined;
  const errLines = stderr.split('\n').filter((l) => /^ERROR|error/i.test(l)).slice(-3).join(' | ');
  const limitHit = code !== 0 && LIMIT_RE.test(errLines || stderr.slice(-2000));
  log({
    at: new Date().toISOString(), session: o.session || null, mode: o.image ? 'image' : 'ask',
    effort: o.effort, search: o.search, attach: o.attach.length, prompt_chars: o.prompt.length,
    prompt_head: o.prompt.slice(0, 80), secs: Math.round((Date.now() - t0) / 1000), exit: code,
    usage, limits, image_ok: imageOk, limit_hit: limitHit || undefined, error: code !== 0 ? errLines.slice(0, 300) : undefined,
  });
  try { fs.rmSync(runDir, { recursive: true, force: true }); } catch {}

  if (code !== 0 || !answer) {
    process.stderr.write(`gpt-ask 실패 (exit ${code}). ${errLines}\n`);
    if (limitHit) process.stderr.write('★한도·인증 문제로 보인다. 다른 계정·키로 넘기지 말고 관리자 세션에 보고하라.\n');
    process.exit(code || 1);
  }
  if (o.image && !imageOk) {
    process.stderr.write(`gpt-ask: 이미지가 저장되지 않았다. GPT 답: ${answer}\n`);
    process.exit(3);
  }
  process.stdout.write(answer + '\n');
}

main().catch((e) => { process.stderr.write(`${e.message}\n`); process.exit(1); });
