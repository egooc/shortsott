// «GPT 손» — 이 기기에서 화면 조작(computer use)이 켜진 Codex 세션을 하나 띄우고 지켜본다.
//
//   · 띄우기: 렌더 락이 있거나 소유주가 방금(2분 안) 이 PC 를 만졌으면 거절한다. 기기당 하나만.
//   · 감시: 5초마다 그 세션 화면을 읽어 멈춤 화면(비밀번호·2단계 인증·결제·계정 만들기·비밀 값·삭제·다른 세션 끄기)이
//     보이면 즉시 중단 키를 보내고, 오피스 결정(ask.js)으로 소유주에게 묻는다. 답은 그 세션 터미널로 들어간다.
//   · 규칙만 믿지 않는다 — 규칙(AGENTS.md)은 세션이 스스로 멈추게, 감시는 못 멈췄을 때 끊는다.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const TITLE_PREFIX = 'GPT 손';
const CU_DIR = path.join(os.homedir(), 'ai-office-cu');

const RULES = `# GPT 손 세션 규칙 (AI 오피스)

이 세션은 소유주의 PC 화면을 직접 조작한다. 아래 화면·행동에 닿으면 **손을 떼고 멈춘 뒤** 무엇을 하려 했는지 한국어 한 줄로 말하고 기다린다.

1. 비밀번호·PIN 입력, 2단계 인증·인증 코드·OTP
2. 결제·구매·카드 번호·구독 변경
3. 계정 만들기·회원가입·소유주 대신 로그인
4. API 키·토큰·비밀번호 같은 비밀 값 보기·복사
5. 파일·데이터·게시물·계정 삭제
6. 다른 터미널·세션·프로그램(Orca, Claude, Codex, CapCut, 렌더) 끄기

- 오피스 감시기가 이 화면을 5초마다 읽고, 위 화면이 보이면 중단 키를 보낸 뒤 소유주에게 묻는다. 답은 «[오피스 결정 답]» 줄로 들어온다 — 그 답대로만 이어 간다.
- 소유주가 지금 이 PC 를 쓰고 있는 것 같으면(마우스가 움직임) 멈추고 묻는다.
- 일을 끝내면 한 줄로 결과만 남긴다. 화면 캡처를 오피스에 보여야 하면 office/share.js 로 올린다.
`;

// 감시 패턴: 멈춤 조건 → 화면 낱말
const STOPS = [
  ['비밀번호 입력', /비밀\s?번호|password|passcode|\bPIN\b/i],
  ['2단계 인증', /2단계|two[- ]factor|2FA|인증\s?코드|verification code|\bOTP\b|authenticator/i],
  ['결제', /결제|구매|카드\s?번호|card number|checkout|payment|purchase|billing|subscribe/i],
  ['계정 만들기', /회원\s?가입|계정\s?만들|sign ?up|create (an )?account|register/i],
  ['비밀 값', /api[_ ]?key|secret|access[_ ]?token|sk-[A-Za-z0-9]{8}|sbp_[A-Za-z0-9]{8}/i],
  ['삭제', /삭제|영구|delete|remove permanently|휴지통 비우/i],
  ['다른 세션 끄기', /taskkill|Stop-Process|terminal close|kill\s+-?\d|프로세스 종료/i],
];

function codexCommand() {
  // 오래된 전역 codex 는 새 모델을 못 쓴다(0.149 실측) — 저장소에 깔아 둔 최신 CLI 를 먼저.
  const local = [
    path.resolve(__dirname, '..', 'tools/gpt-ask-cli/node_modules/@openai/codex/bin/codex.js'),
    path.join(__dirname, 'node_modules/@openai/codex/bin/codex.js'),
  ].find((p) => fs.existsSync(p));
  return local ? `"${process.execPath}" "${local}"` : 'codex';
}

function caps() {
  const homes = [path.join(os.homedir(), '.codex'), path.join(os.homedir(), 'AppData/Roaming/orca/codex-runtime-home/home')];
  const cu = homes.some((h) => { try { return /computer-use/.test(fs.readFileSync(path.join(h, 'config.toml'), 'utf8')); } catch { return false; } });
  return { platform: process.platform, computer_use: process.platform === 'win32' && cu, codex: codexCommand() };
}

// 소유주가 마지막으로 마우스·키보드를 만진 지 몇 초인지(윈도만).
function userIdleSeconds() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const ps = `Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Idle { [StructLayout(LayoutKind.Sequential)] struct LII { public uint cbSize; public uint dwTime; }
[DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LII p);
public static uint Sec() { var l = new LII(); l.cbSize = (uint)Marshal.SizeOf(l); GetLastInputInfo(ref l); return ((uint)Environment.TickCount - l.dwTime) / 1000; } }
"@; [Idle]::Sec()`;
  return new Promise((res) => execFile('powershell', ['-NoProfile', '-Command', ps], { timeout: 20e3, windowsHide: true },
    (e, out) => res(e ? null : Number(String(out).trim()))));
}

function makeCu({ orca, activeLocks, appendHandoff, log, device }) {
  const watched = new Map(); // handle → { seen: Set(lines), lastAsk: {kind: ms} }

  const isCu = (t) => String(t.title || '').replace(/^[^\p{L}\p{N}]+/u, '').startsWith(TITLE_PREFIX);

  async function launch({ force } = {}) {
    const c = caps();
    if (!c.computer_use) throw new Error('이 기기에는 화면 조작이 켜진 Codex 가 없다');
    const locks = activeLocks();
    if (locks.length) throw new Error(`렌더 중(${locks.join(', ')}) — 렌더가 끝난 뒤 연다`);
    const terms = await orca(['terminal', 'list']);
    if ((terms.terminals || []).some(isCu)) throw new Error('이 기기에는 이미 GPT 손 세션이 있다');
    const idle = await userIdleSeconds();
    if (!force && idle != null && idle < 120) throw new Error(`소유주가 ${idle}초 전에 이 PC 를 만졌다 — 쓰는 중이면 마우스를 빼앗는다. 그래도 열려면 강행`);
    fs.mkdirSync(CU_DIR, { recursive: true });
    fs.writeFileSync(path.join(CU_DIR, 'AGENTS.md'), RULES, 'utf8');
    const start = path.join(CU_DIR, 'start-cu.cmd');
    fs.writeFileSync(start, `@echo off\r\nset CODEX_HOME=%USERPROFILE%\\.codex\r\ncd /d "%~dp0"\r\n${c.codex} -a never -s workspace-write\r\n`, 'utf8');
    // Orca 는 git 저장소만 작업 폴더로 받는다 — 빈 저장소로 만든다(커밋·원격 없음).
    if (!fs.existsSync(path.join(CU_DIR, '.git'))) await new Promise((res, rej) => execFile('git', ['init', '-q', CU_DIR], { windowsHide: true }, (e) => e ? rej(new Error('git init 실패: ' + e.message)) : res()));
    try { await orca(['repo', 'add', '--path', CU_DIR]); } catch (e) { if (!/already|이미/i.test(e.message)) throw e; }
    const title = `${TITLE_PREFIX} · ${device}`;
    const r = await orca(['terminal', 'create', '--worktree', `path:${CU_DIR}`, '--title', title, '--command', `cmd /c "${start}"`], 60e3);
    appendHandoff(`GPT 손 세션 띄움 — ${device}${force ? ' (소유주 사용 중 강행)' : ''}`);
    return r;
  }

  async function ask(handle, kind, line) {
    const ask = path.join(__dirname, 'ask.js');
    const q = `GPT 손(${device})이 «${kind}» 화면에 닿아 멈췄습니다. 화면: «${line.slice(0, 120)}» 이어서 할까요?`;
    await new Promise((res) => execFile(process.execPath, [ask, q, '--lane', 'GPT 손', '--options', '이어서 해|멈추고 기다려|그 일은 그만둬', '--rec', '멈추고 기다려', '--from', `${TITLE_PREFIX} · ${device}`],
      { timeout: 30e3, windowsHide: true, env: { ...process.env, ORCA_TERMINAL_HANDLE: handle } }, () => res()));
  }

  async function watch() {
    let terms;
    try { terms = await orca(['terminal', 'list']); } catch { return; }
    const live = (terms.terminals || []).filter(isCu);
    for (const h of [...watched.keys()]) if (!live.some((t) => t.handle === h)) watched.delete(h);
    for (const t of live) {
      let w = watched.get(t.handle);
      let screen;
      try { screen = await orca(['terminal', 'read', '--terminal', t.handle, '--screen']); } catch { continue; }
      const lines = (screen.terminal?.tail || []).map(String).map((l) => l.trim()).filter(Boolean);
      if (!w) { w = { seen: new Set(lines), lastAsk: {} }; watched.set(t.handle, w); continue; } // 처음 본 화면은 기준으로만
      const fresh = lines.filter((l) => !w.seen.has(l) && !l.startsWith('[오피스'));
      for (const l of fresh) w.seen.add(l);
      if (w.seen.size > 2000) w.seen = new Set(lines);
      for (const l of fresh) {
        const hit = STOPS.find(([, re]) => re.test(l));
        if (!hit) continue;
        const [kind] = hit;
        if (Date.now() - (w.lastAsk[kind] || 0) < 10 * 60e3) break;
        w.lastAsk[kind] = Date.now();
        try { await orca(['terminal', 'send', '--terminal', t.handle, '--text', '\u001b', '--interrupt']); } catch {}
        try { await orca(['terminal', 'send', '--terminal', t.handle, '--text', `[오피스 감시] «${kind}» 화면이 보여 멈췄다. 소유주 답이 올 때까지 손대지 말 것.`, '--enter']); } catch {}
        await ask(t.handle, kind, l);
        appendHandoff(`GPT 손 멈춤 — ${device} «${kind}» 감지, 소유주에게 물음`);
        log('GPT 손 멈춤', kind);
        break;
      }
    }
  }

  return { launch, watch, caps };
}

module.exports = { makeCu, caps, TITLE_PREFIX };
