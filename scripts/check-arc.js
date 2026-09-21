// Does the cut stand on its own as a story?
//
//   node scripts/check-arc.js <compress run id | dir> [--json]
//
// The owner's criterion, stated 2026-09-01: "그 클립 내에 스토리 아크만 완성되면 되는거잖아.
// 메인스토리 파편 빼고." Two questions, and neither is positional:
//   1. Do the kept slots form setup -> turn -> resolution on their own?
//   2. Does any kept line lean on a person, event or stake the cut never shows?
//
// Positional proxies were tried first and failed. Average source jump separated the three
// labelled cuts (Jacob 19s and Volterra 31s read fine, Draft Day 55s did not) but measures
// travel, not coherence: a long jump that discards main-story scaffolding leaves the arc
// intact, and a tight cut with no arc is still unfollowable. The plan's own standalone_score
// does not separate them either - 0.80 / 0.81 / 0.80 across all three. This is the same lesson
// the narration_visual_match gate already recorded: the defect is SEMANTIC, so the judge has
// to read meaning.
//
// Runs on the plan, before fills, TTS and the draft - the point where dropping a source is
// still cheap.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); }
catch { /* env comes from the process */ }

const TEST_RUNS = path.join(ROOT, 'midform', 'test_runs');
const MAX_OUTSIDE_DEPENDENCIES = 2;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    arc_complete: { type: 'boolean' },
    setup: { type: 'string' },
    turn: { type: 'string' },
    resolution: { type: 'string' },
    missing_stage: { type: 'string' },
    outside_dependencies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slot_id: { type: 'string' },
          line: { type: 'string' },
          depends_on: { type: 'string' }
        },
        required: ['slot_id', 'line', 'depends_on']
      }
    },
    followable_without_the_film: { type: 'boolean' },
    reason: { type: 'string' }
  },
  required: ['arc_complete', 'outside_dependencies', 'followable_without_the_film', 'reason']
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// What the viewer will actually receive: the kept slots in playback order, each with the lines
// it carries. Source timestamps are deliberately NOT included - the judge should read the cut
// as an audience does, with no knowledge of where in the film each piece came from.
function renderCut(plan) {
  const kept = (plan.timeline || []).filter((slot) => String(slot.decision || '') !== 'SKIP');
  return kept.map((slot, index) => {
    const decision = String(slot.decision || '');
    const quotes = []
      .concat(slot.dialogue_focus_quotes || [])
      .concat(slot.dialogue_anchor_quotes || [])
      .concat(slot.dialogue_focus_lines || [])
      .map((q) => String(typeof q === 'string' ? q : (q && (q.text || q.quote)) || '').trim())
      .filter(Boolean);
    const uniqueQuotes = [...new Set(quotes)].slice(0, 6);
    const body = decision === 'NARRATE'
      ? `[해설 자리] ${String(slot.reason || '').slice(0, 120)}`
      : (uniqueQuotes.length ? uniqueQuotes.map((q) => `  "${q}"`).join('\n') : '(대사 미지정)');
    return `${index + 1}. slot=${slot.slot_id || index} role=${slot.role || '?'} ${decision}\n${body}`;
  }).join('\n');
}

function buildPrompt(plan, sourceTitle) {
  return [
    'You are judging a short recap cut assembled from ONE movie clip. Below is the cut in',
    'playback order: every slot the viewer will see, with the lines it carries. NARRATE slots',
    'are places where a narrator sentence will be written; their text does not exist yet, so',
    'treat them as "a bridging sentence can be placed here".',
    '',
    `Source clip: ${sourceTitle}`,
    '',
    'THE CUT:',
    renderCut(plan),
    '',
    'Judge two things, as a viewer who has never seen the film:',
    '',
    '1. arc_complete — do these slots form a self-contained story: a setup that establishes who',
    '   and what is at stake, a turn where something changes, and a resolution or a landed',
    '   reveal? Name each stage if present. If a stage is missing, say which in missing_stage.',
    '   A cut can jump far inside the source and still be complete; distance is not the test.',
    '',
    '2. outside_dependencies — list kept lines that only make sense if the viewer knows a',
    '   person, event, relationship or stake that this cut never shows. These are main-story',
    '   fragments that should have been edited OUT. For each, give the slot, the line, and what',
    '   it depends on. Do NOT list a line merely because a name is new - a name introduced by a',
    '   bridging sentence is fine. List it when the MEANING is unavailable: a callback to an',
    '   earlier scene, a stake established elsewhere, a relationship never shown.',
    '',
    'followable_without_the_film: can someone with no knowledge of the film follow this cut end',
    'to end? Be strict. If a viewer would ask "who is this" or "why does this matter" and the',
    'cut never answers, the answer is false.',
    '',
    'reason: one or two sentences, concrete, naming the specific gap or confirming the arc.',
    '',
    'Return JSON only.'
  ].join('\n');
}

async function analyzeArc(runDir) {
  const name = path.basename(runDir);
  const plan = readJson(path.join(runDir, 'edit_plan.json'), null);
  if (!plan) return { run: name, error: 'edit_plan.json 없음' };
  const info = readJson(path.join(runDir, 'source_info.json'), {});
  const { generateStructuredJson } = require('../server/services/geminiMidformService');
  const raw = await generateStructuredJson({
    prompt: buildPrompt(plan, String(info.title || name)),
    responseSchema: RESPONSE_SCHEMA,
    temperature: 0
  });
  let verdictJson;
  try { verdictJson = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); }
  catch { return { run: name, error: '판정 응답을 파싱할 수 없음' }; }

  const outside = Array.isArray(verdictJson.outside_dependencies) ? verdictJson.outside_dependencies : [];
  // Only arc_complete decides. Calibrated against the owner's own verdicts on three cuts:
  //   Jacob    arc true,  followable false, 9 dependencies -> he found it fine
  //   Volterra arc true,  followable false, 5 dependencies -> he found it fine
  //   DraftDay arc false, followable false, 7 dependencies -> "따라가기 어렵다"
  // followable_without_the_film comes back false for everything - a movie clip always leaves
  // some residue, so that question cannot separate a good cut from a bad one. The dependency
  // count does not separate them either: the cut he liked best had the most. Both stay in the
  // report because they say WHERE the residue is, which is useful when fixing a plan; neither
  // is allowed to fail a run.
  const verdict = verdictJson.arc_complete === false
    ? 'FAIL'
    : (outside.length > MAX_OUTSIDE_DEPENDENCIES ? 'WARN' : 'PASS');
  return {
    run: name,
    verdict,
    arc_complete: verdictJson.arc_complete === true,
    followable: verdictJson.followable_without_the_film === true,
    missing_stage: verdictJson.missing_stage || '',
    setup: verdictJson.setup || '',
    turn: verdictJson.turn || '',
    resolution: verdictJson.resolution || '',
    outside_dependencies: outside,
    reason: verdictJson.reason || ''
  };
}

async function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--')) || '';
  const dir = fs.existsSync(target) ? target : path.join(TEST_RUNS, path.basename(target));
  const result = await analyzeArc(dir);
  if (args.includes('--json')) { console.log(JSON.stringify(result, null, 2)); return; }

  if (result.error) { console.log(`${result.run}: ${result.error}`); process.exitCode = 1; return; }
  console.log(`[${result.verdict}] ${result.run}`);
  console.log(`   아크 완결 ${result.arc_complete ? 'O' : 'X'} | 영화 몰라도 따라감 ${result.followable ? 'O' : 'X'}`
    + (result.missing_stage ? ` | 빠진 단계: ${result.missing_stage}` : ''));
  if (result.setup) console.log(`   셋업: ${result.setup.slice(0, 90)}`);
  if (result.turn) console.log(`   전환: ${result.turn.slice(0, 90)}`);
  if (result.resolution) console.log(`   결말: ${result.resolution.slice(0, 90)}`);
  if (result.outside_dependencies.length) {
    console.log(`   클립 밖 의존 ${result.outside_dependencies.length}건:`);
    for (const d of result.outside_dependencies.slice(0, 5)) {
      console.log(`     - [${d.slot_id}] "${String(d.line).slice(0, 40)}" → ${String(d.depends_on).slice(0, 60)}`);
    }
  }
  console.log(`   판단: ${result.reason}`);
  if (result.verdict === 'FAIL') process.exitCode = 1;
}

if (require.main === module) main().catch((e) => { console.error('check-arc fatal:', e.message || e); process.exitCode = 1; });

module.exports = { analyzeArc, MAX_OUTSIDE_DEPENDENCIES };
