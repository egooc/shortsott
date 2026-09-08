// Gate: read what SHIPS, and see whether it tells a story.
//
//   node scripts/check-story-legible.js <draft folder> [--json]
//   node scripts/check-story-legible.js --all
//
// check-arc.js already asks whether a cut is a complete story - and it passed Breaking Dawn 1's
// blood-smoothie cut with "no essential meaning depends on prior knowledge of the film". The
// owner read the same cut and could not follow it. Both were right about different texts: the
// arc judge reads the PLAN, whose lines are the English source ("Maybe I can figure out what IT
// wants", sitting right beside "I can only see the fetus"), while the viewer reads the Korean
// caption, which drops the subject entirely - "뭘 원하는지 알아낼 수도 있어". Nothing in the
// shipped text ever says the thing that is thirsty is the unborn child. The referent exists only
// in a language nobody watching will see (2026-09-04).
//
// So this gate reads the DRAFT, not the plan: captions and narration in playback order, per
// locale, exactly as they reach the screen. Two questions, both answerable only from that text:
//   1. Does every line that carries the story have its subject somewhere in this text?
//   2. When a character's situation changes, does this text say why?
// The second is what broke the Jacob cut - he jokes in a cinema, then twenty-three silent
// seconds later he has a tattoo and tells Bella to go away. He became a werewolf; the cut never
// says so, and no structural gate can see an absence.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); }
catch { /* env comes from the process */ }

const DRAFTS_DIR = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');
// Chunks of one sentence arrive as separate captions; rejoin them so the judge reads sentences.
const CHUNK_JOIN_GAP_SEC = 2.2;
// A hole this long is something the viewer sits through, so the judge should see it too.
const SILENCE_WORTH_SHOWING_SEC = 8;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    story_legible: { type: 'boolean' },
    viewer_takeaway: { type: 'string' },
    unresolved_references: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          line: { type: 'string' },
          missing: { type: 'string' }
        },
        required: ['line', 'missing']
      }
    },
    unexplained_changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          at_line: { type: 'string' },
          changed: { type: 'string' }
        },
        required: ['at_line', 'changed']
      }
    },
    reason: { type: 'string' }
  },
  required: ['story_legible', 'viewer_takeaway', 'unresolved_references', 'unexplained_changes', 'reason']
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// The script as the viewer receives it: speaker labels, dialogue, narration, silences.
function renderScript(draftDir) {
  const manifest = readJson(path.join(draftDir, 'edit_manifest.json'), null);
  if (!manifest) return null;
  const seen = new Set();
  const rows = [];
  const ordered = (manifest.segments || [])
    .slice()
    .sort((a, b) => (a.timeline_start_sec || 0) - (b.timeline_start_sec || 0));
  for (const segment of ordered) {
    const key = `${segment.segment_id}|${segment.caption_id || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = String(segment.narration || '').trim();
    if (!text) continue;
    const isNarration = /recap|narration/i.test(String(segment.segment_type || ''));
    rows.push({
      at: Number(segment.timeline_start_sec || 0),
      speaker: isNarration ? '해설' : String(segment.speaker_alias || segment.speaker || '?'),
      text,
      isNarration
    });
  }

  const merged = [];
  for (const row of rows) {
    const prev = merged[merged.length - 1];
    if (prev && !prev.isNarration && !row.isNarration && prev.speaker === row.speaker
      && row.at - prev.lastAt < CHUNK_JOIN_GAP_SEC && !/[.!?…]$/.test(prev.text)) {
      prev.text += ` ${row.text}`;
      prev.lastAt = row.at;
      continue;
    }
    merged.push({ ...row, lastAt: row.at });
  }

  const lines = [];
  let previousEnd = 0;
  for (const row of merged) {
    const gap = row.at - previousEnd;
    if (previousEnd > 0 && gap >= SILENCE_WORTH_SHOWING_SEC) {
      lines.push(`   (대사도 해설도 없는 ${Math.round(gap)}초)`);
    }
    lines.push(row.isNarration ? `   [해설] ${row.text}` : `   ${row.speaker}: ${row.text}`);
    previousEnd = row.lastAt;
  }
  return { text: lines.join('\n'), manifest, lineCount: merged.length };
}

function buildPrompt(script, title, locale) {
  const language = locale === 'ja' ? 'Japanese' : 'Korean';
  return [
    `Below is the COMPLETE ${language} text of a short recap video, in playback order, exactly as`,
    'it reaches the screen: dialogue with speaker names, narration marked [해설], and any stretch',
    'with no text at all. This is everything the viewer receives. There is no other text.',
    '',
    `Title: ${title}`,
    '',
    'THE SCRIPT:',
    script,
    '',
    'You have never seen the film. Judge ONLY from the text above.',
    '',
    '1. unresolved_references - quote every line whose subject or referent never appears anywhere',
    '   in this text. Dropped subjects are the usual case: a line about what something wants, or',
    '   that someone is thirsty, when the text never names what or who. Give the line and say what',
    '   is missing. Do NOT list a line whose referent appears elsewhere in the text, even far away;',
    '   the viewer can hold it. Do NOT list ordinary conversational ellipsis where the referent is',
    '   obvious from the line immediately before it.',
    '',
    '2. unexplained_changes - quote any line where a person\'s situation, appearance or stance has',
    '   changed from earlier in the text with nothing in the text accounting for it: someone warm',
    '   who turns hostile, or who has visibly transformed, and no line or narration says why.',
    '',
    'viewer_takeaway: in one or two sentences, the story someone would actually come away with',
    'from this text alone. If they would come away confused, say what about - do not fill the gap',
    'with knowledge you have from outside the text.',
    '',
    'story_legible: true only if a first-time viewer follows this start to finish without needing',
    'anything the text does not give them. Be strict, but do not demand backstory a short recap',
    'has no room for - the test is whether the SCENE it shows makes sense on its own.',
    '',
    'reason: one or two concrete sentences.',
    '',
    'Return JSON only.'
  ].join('\n');
}

async function analyze(draftDir) {
  const name = path.basename(draftDir);
  const rendered = renderScript(draftDir);
  if (!rendered) return { draft: name, error: 'edit_manifest.json 없음' };
  // Never send an empty script to the judge. Asked to rate a page of instructions with no text
  // under it, the model answers honestly - "only the guidance was provided" - and that comes back
  // as story_legible:false, so a finished cut is blocked by a gate that never saw it. Measured on
  // War Dogs 2026-09-04: the ko run reported FAIL quoting the prompt's own first line while the
  // renderer, run again on the same folder, produced twelve lines. An absent script is a
  // measurement failure, not a verdict.
  if (rendered.lineCount < 3 || rendered.text.trim().length < 60) {
    return { draft: name, error: `대본이 비어 판정 불가 (${rendered.lineCount}줄, ${rendered.text.trim().length}자)` };
  }
  const locale = /(-|_)ja$/.test(name) ? 'ja' : 'ko';
  const runDir = path.dirname(String(rendered.manifest.source_video_path || ''));
  const info = readJson(path.join(runDir, 'source_info.json'), {});
  const { generateStructuredJson } = require('../server/services/geminiMidformService');
  const prompt = buildPrompt(rendered.text, String(info.title || name), locale);

  // The judge intermittently answers as if the script were not there - "평가 기준만 있고 한국어
  // 서사 본문은 없다" - and quotes the prompt's own first line as the missing reference. Measured
  // 2026-09-04 on War Dogs: the same folder, the same twelve lines, at temperature 0, returned
  // PASS and then FAIL on consecutive runs. A verdict whose quoted lines appear nowhere in the
  // script did not read the script, so it is a failed measurement and gets retried rather than
  // shipped as a defect - otherwise a finished cut is blocked by a coin flip.
  const sawTheScript = (verdict) => {
    const quoted = [
      ...(Array.isArray(verdict.unresolved_references) ? verdict.unresolved_references : []).map((x) => x.line),
      ...(Array.isArray(verdict.unexplained_changes) ? verdict.unexplained_changes : []).map((x) => x.at_line)
    ].map((line) => String(line || '').trim()).filter(Boolean);
    // reason 이 '본문이 없다'고 주장하면 인용이 비어 있어도 미독이다 - 빈 인용은 이 거부
    // 응답의 형태 그 자체라 기존 통과 조건의 틈이었다 (바스터즈 ko 2회 실측).
    const claimsNoScript = /no story text|evaluation instructions|본문은 없|서사 본문|no narration, dialogue|story to evaluate/i
      .test(String(verdict.reason || '') + String(verdict.viewer_takeaway || ''));
    if (claimsNoScript) return false;
    if (!quoted.length) return true;                       // nothing quoted - nothing to check
    return quoted.some((line) => rendered.text.includes(line.slice(0, 12)));
  };

  let verdictJson = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = await generateStructuredJson({ prompt, responseSchema: RESPONSE_SCHEMA, temperature: 0 });
    let parsed;
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); }
    catch { continue; }
    if (parsed.story_legible === true || sawTheScript(parsed)) { verdictJson = parsed; break; }
  }
  if (!verdictJson) return { draft: name, error: '판정기가 대본을 읽지 못함 (3회 재시도 후) — 판정 불가' };

  const unresolved = Array.isArray(verdictJson.unresolved_references) ? verdictJson.unresolved_references : [];
  const changes = Array.isArray(verdictJson.unexplained_changes) ? verdictJson.unexplained_changes : [];
  // story_legible is the verdict. The findings say WHERE to fix it and are reported even on a
  // pass, because a cut can carry one loose pronoun and still be worth tightening.
  return {
    draft: name,
    locale,
    lines: rendered.lineCount,
    verdict: verdictJson.story_legible === false ? 'FAIL' : (unresolved.length || changes.length ? 'WARN' : 'PASS'),
    story_legible: verdictJson.story_legible === true,
    viewer_takeaway: String(verdictJson.viewer_takeaway || ''),
    unresolved_references: unresolved,
    unexplained_changes: changes,
    reason: String(verdictJson.reason || '')
  };
}

async function main() {
  const args = process.argv.slice(2);
  const targets = args.includes('--all')
    ? fs.readdirSync(DRAFTS_DIR)
      .filter((n) => /^\d{8}[a-z]?-.+-(ko|ja)$/.test(n))
      .map((n) => path.join(DRAFTS_DIR, n))
    : [path.resolve(args.find((a) => !a.startsWith('--')) || '')];

  const results = [];
  for (const target of targets) results.push(await analyze(target));
  if (args.includes('--json')) { console.log(JSON.stringify(results, null, 2)); return; }

  for (const r of results) {
    if (r.error) { console.log(`${r.draft}: ${r.error}`); continue; }
    if (args.includes('--all') && r.verdict === 'PASS') continue;
    console.log(`\n[${r.verdict}] ${r.draft} — ${r.lines}줄`);
    console.log(`   시청자가 받는 이야기: ${r.viewer_takeaway}`);
    if (r.unresolved_references.length) {
      console.log(`   가리키는 대상 없음 ${r.unresolved_references.length}건:`);
      for (const u of r.unresolved_references.slice(0, 5)) {
        console.log(`     - "${String(u.line).slice(0, 42)}" → ${String(u.missing).slice(0, 70)}`);
      }
    }
    if (r.unexplained_changes.length) {
      console.log(`   설명 없는 변화 ${r.unexplained_changes.length}건:`);
      for (const c of r.unexplained_changes.slice(0, 4)) {
        console.log(`     - "${String(c.at_line).slice(0, 42)}" → ${String(c.changed).slice(0, 70)}`);
      }
    }
    console.log(`   판단: ${r.reason}`);
  }
  if (args.includes('--all')) {
    const fail = results.filter((r) => r.verdict === 'FAIL').length;
    const warn = results.filter((r) => r.verdict === 'WARN').length;
    console.log(`\n판정 ${results.filter((r) => !r.error).length}편 | FAIL ${fail} · WARN ${warn}`);
  }
  if (results.some((r) => r.verdict === 'FAIL')) process.exitCode = 1;
}

if (require.main === module) main().catch((e) => { console.error('check-story-legible fatal:', e.message || e); process.exitCode = 1; });

module.exports = { analyze, renderScript };
