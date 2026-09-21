// Gate: did the cut keep an ANSWER whose QUESTION it dropped?
//
//   node scripts/check-dialogue-pairs.js <draft folder> [--json]
//   node scripts/check-dialogue-pairs.js --all          # screen every installed draft
//
// Found on Wishmaster 2 (2026-09-01): the scene is Morgana answering a priest, and the priest's
// questions - "Why do you presume he's dead?", "been to the police?" - were dropped while her
// answers were kept. Read end to end, she replies to nobody. The same cut left the antagonist's
// echo-questions standing with nothing to echo, so he interrogates himself. Every earlier gate
// measured position, length and visuals; none asks whether the surviving lines still form an
// exchange.
//
// That second diagnosis was WRONG, re-measured 2026-09-03. The question is on screen. The
// auto-caption had merged both speakers into one cue - "How do you know my name? I've been
// expecting you." - and the draft handed all three of its chunks to Demarest. He asks and
// answers himself because of SPEAKER assignment, not a missing line. That is now its own
// check (merged_cue_one_speaker), and the echo check judges retention from the source rather
// than hunting a question mark on our own timeline - which had made one cut pass in ja and
// fail in ko, measuring the translation instead of the edit.
//
// Judged against the SOURCE, not the copy: manifest segments carry source_utterance_id, so the
// cue that preceded each kept line is knowable. If that cue was a question, sits within a
// conversational gap, and was NOT kept, the kept line is an orphaned answer.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DRAFTS_DIR = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');

// A reply follows its question closely. Beyond this the two lines are not a pair and dropping
// one is ordinary editing, not a broken exchange.
const PAIR_GAP_MAX_SEC = 4.0;
// Korean/Japanese restatement of a question the speaker was just asked. Kept without the
// original, it reads as the character questioning himself.
const ECHO_QUESTION = /(냐고|라고|다고|느냐고|かって|のかって)\s*[?？]/;
// How long a run of pure dialogue can go before the viewer loses the thread. Measured on
// Draft Day (2026-09-01): a 67-second stretch spanning a room change and two speakers who had
// not been heard before, with no narration in it, and the cut stopped being followable.
const NARRATION_GAP_MAX_SEC = 40;

// Transcripts carry non-speech cues - "[Music]", "[Applause]" - between spoken lines. They are
// never "kept", so treating the immediately preceding cue as the antecedent made a line look
// orphaned whenever a music tag sat between it and the line it answers. Measured on the New Moon
// breakup: "You don't want me" is preceded by [Music] at 111.1-117.1, with the line it echoes
// one cue further back and present in the cut (2026-09-03).
const NON_SPEECH = /^\s*[\[(][^\])]*[\])]\s*$/;

function previousSpeechCue(cues, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    const text = String(cues[i].text || '').trim();
    if (!text || NON_SPEECH.test(text)) continue;
    return cues[i];
  }
  return null;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function sourceCues(draftDir) {
  const manifest = readJson(path.join(draftDir, 'edit_manifest.json'), null);
  if (!manifest) return { cues: [], manifest: null };
  const runDir = path.dirname(String(manifest.source_video_path || ''));
  const transcript = readJson(path.join(runDir, 'source_transcript.json'), null);
  const cues = (transcript && (transcript.cues || transcript.segments || transcript.utterances)) || [];
  return { cues, manifest };
}

function analyze(draftDir) {
  const { cues, manifest } = sourceCues(draftDir);
  const name = path.basename(draftDir);
  if (!manifest) return { draft: name, error: 'edit_manifest.json 없음' };
  if (!cues.length) return { draft: name, error: 'source_transcript 없음 — 판정 불가' };

  const byId = new Map();
  cues.forEach((cue, index) => { if (cue.utt_id) byId.set(String(cue.utt_id), { ...cue, index }); });

  const kept = [];
  const keptIds = new Set();
  const seen = new Set();
  for (const segment of manifest.segments || []) {
    const key = `${segment.segment_id}|${segment.caption_id || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = String(segment.narration || '').trim();
    if (!text) continue;
    const isDialogue = !/recap|narration/i.test(String(segment.segment_type || ''));
    const entry = {
      text,
      isDialogue,
      startSec: Number(segment.timeline_start_sec || 0),
      speaker: segment.speaker_alias || segment.speaker || '',
      uttId: segment.source_utterance_id ? String(segment.source_utterance_id) : ''
    };
    kept.push(entry);
    if (entry.uttId) keptIds.add(entry.uttId);
  }

  // How many on-screen lines each source cue produced. A cue that holds both halves of an
  // exchange needs at least two, or one half never reached the screen.
  const captionsPerCue = new Map();
  for (const line of kept) {
    if (!line.isDialogue || !line.uttId) continue;
    captionsPerCue.set(line.uttId, (captionsPerCue.get(line.uttId) || 0) + 1);
  }

  const findings = [];
  const countedDrops = new Set();
  for (const line of kept) {
    if (!line.isDialogue) continue;

    // 1. Orphaned answer: the source cue right before this one asked something, and it was cut.
    const cue = line.uttId ? byId.get(line.uttId) : null;
    const prevSpeech = cue && cue.index > 0 ? previousSpeechCue(cues, cue.index) : null;
    if (cue && prevSpeech) {
      const prev = prevSpeech;
      const gap = Number(cue.start || 0) - Number(prev.end || prev.start || 0);
      const prevIsQuestion = /[?？]\s*$/.test(String(prev.text || '').trim());
      const prevKept = prev.utt_id && keptIds.has(String(prev.utt_id));
      // One finding per dropped question, not per caption chunk: a single answer is split
      // across several on-screen lines and each one would otherwise re-report the same gap.
      const dropKey = String(prev.utt_id || prev.start || prev.text);
      if (prevIsQuestion && !prevKept && gap >= 0 && gap <= PAIR_GAP_MAX_SEC && !countedDrops.has(dropKey)) {
        countedDrops.add(dropKey);
        findings.push({
          type: 'orphan_answer',
          atSec: line.startSec,
          speaker: line.speaker,
          kept: line.text,
          droppedQuestion: String(prev.text || '').trim().slice(0, 90)
        });
      }
    }

    // 2. Echo question with nothing to echo: the line restates a question, but no kept line
    //    before it (within the pair window on OUR timeline) actually asked one.
    if (ECHO_QUESTION.test(line.text)) {
      // What an echo needs is the line it echoes, and that is usually a STATEMENT: Edward's
      // "아무것도 아니라고?" throws Bella's "it's nothing" back at her. Requiring a prior
      // question mark on our own timeline made this gate locale-sensitive - the same cut
      // passed in ja and failed in ko, because the translations word the antecedent
      // differently and only one ends in "?" (New Moon breakup, 2026-09-03). A gate that
      // judges one cut two ways is measuring the translation, not the edit.
      // The source settles it: the cue before the echo's own cue is the thing being echoed,
      // so the question is simply whether the cut kept it.
      const echoCue = line.uttId ? byId.get(line.uttId) : null;
      let hasAntecedent;
      const echoPrev = echoCue && echoCue.index > 0 ? previousSpeechCue(cues, echoCue.index) : null;
      if (echoPrev) {
        hasAntecedent = Boolean(echoPrev.utt_id && keptIds.has(String(echoPrev.utt_id)));
        // A cue often holds BOTH halves: the auto-caption merges "How do you know my name?"
        // with the reply into one line. Keeping that cue is not enough - if the cut wrote only
        // one caption for it, the half that reached the screen is the echo and the question is
        // gone. This is exactly the Wishmaster 2 defect the gate was built for: all five echoes
        // there had their question inside their own kept cue, so a retention-only test waves
        // them through (2026-09-03).
        const ownText = String((echoCue && echoCue.text) || '');
        const questionSharesCue = /\?\s*\S/.test(ownText);
        if (questionSharesCue && (captionsPerCue.get(line.uttId) || 0) <= 1) hasAntecedent = false;
      } else {
        // No source anchor - fall back to the timeline: any kept line from someone else,
        // close enough to belong to the same exchange.
        hasAntecedent = kept.some((other) => other !== line
          && other.isDialogue
          && other.startSec < line.startSec
          && line.startSec - other.startSec <= PAIR_GAP_MAX_SEC * 2
          && other.speaker !== line.speaker);
      }
      if (!hasAntecedent) {
        findings.push({
          type: 'echo_without_question',
          atSec: line.startSec,
          speaker: line.speaker,
          kept: line.text
        });
      }
    }
  }

  // 3. A long dialogue run with no narration is only a problem when something inside it
  //    changed - a speaker the viewer has not met yet. Silence over a continuous two-hander is
  //    fine; silence across an entrance is where the thread is dropped.
  const ordered = [...kept].sort((a, b) => a.startSec - b.startSec);
  const heardBefore = new Set();
  let runStart = 0;
  let newcomersInRun = [];
  for (const line of ordered) {
    if (!line.isDialogue) {
      // A narration lands: the run resets and whoever appeared in it has been covered.
      runStart = line.startSec;
      newcomersInRun = [];
      continue;
    }
    if (line.speaker && !heardBefore.has(line.speaker)) {
      heardBefore.add(line.speaker);
      if (line.startSec > runStart) newcomersInRun.push({ speaker: line.speaker, atSec: line.startSec });
    }
    const runLength = line.startSec - runStart;
    if (runLength > NARRATION_GAP_MAX_SEC && newcomersInRun.length) {
      findings.push({
        type: 'narration_gap',
        atSec: runStart,
        gapSec: Number(runLength.toFixed(1)),
        newcomers: newcomersInRun.map((n) => `${n.speaker}(${n.atSec.toFixed(0)}s)`)
      });
      runStart = line.startSec;   // report a stretch once, then keep walking
      newcomersInRun = [];
    }
  }

  // 4. One cue, two speakers, one name. When the source caption merges an exchange into a
  //    single cue - a question followed by its answer - the draft splits it into chunks but can
  //    hand every chunk to the same speaker. Every line is present and still unreadable: the
  //    character interrogates himself. Only cues carrying both halves are judged, so a single
  //    speaker's own rhetorical question is not a finding.
  const chunksByCue = new Map();
  for (const line of kept) {
    if (!line.isDialogue || !line.uttId) continue;
    if (!chunksByCue.has(line.uttId)) chunksByCue.set(line.uttId, []);
    chunksByCue.get(line.uttId).push(line);
  }
  for (const [uttId, chunks] of chunksByCue) {
    if (chunks.length < 2) continue;
    const cue = byId.get(uttId);
    // Two speakers means a question ANSWERED, not a run of questions. "What prophecy? And why
    // me? What is it about me?" is one person pressing; "How do you know my name? I've been
    // expecting you." is two. Judge by what follows the LAST question mark: a statement of
    // real length is the answer, and the answer is the second speaker.
    const cueText = String((cue && cue.text) || '');
    const afterLastQuestion = cueText.slice(cueText.lastIndexOf('?') + 1).trim();
    const looksAnswered = cueText.includes('?')
      && afterLastQuestion.split(/\s+/).filter(Boolean).length >= 2;
    if (!cue || !looksAnswered) continue;
    const speakers = new Set(chunks.map((c) => c.speaker).filter(Boolean));
    if (speakers.size !== 1) continue;
    findings.push({
      type: 'merged_cue_one_speaker',
      atSec: Math.min(...chunks.map((c) => c.startSec)),
      speaker: chunks[0].speaker,
      kept: chunks.map((c) => c.text).join(' / ').slice(0, 70),
      sourceCue: String(cue.text || '').slice(0, 80)
    });
  }

  const dialogueCount = kept.filter((k) => k.isDialogue).length;
  const echoes = findings.filter((f) => f.type === 'echo_without_question').length;
  const orphans = findings.filter((f) => f.type === 'orphan_answer').length;
  const gaps = findings.filter((f) => f.type === 'narration_gap').length;
  const merged = findings.filter((f) => f.type === 'merged_cue_one_speaker').length;
  // The two defects are not equally bad. A dropped question is often recoverable from what
  // the answer itself carries ("Who's this?" -> "It's Bella Swan. Who else?" stands alone), so
  // orphans are a smell. An echo with nothing to echo cannot be read at all - the character
  // interrogates himself - so a single one is a defect and two make the cut unusable.
  // Calibrated on measured pairs: Wishmaster 2 (broken, 3 echoes) vs Jacob (fine, 0 echoes).
  const verdict = (echoes + merged) >= 2 ? 'FAIL'
    : (echoes + merged === 1 || orphans >= 5 || gaps >= 1) ? 'WARN'
      : 'PASS';
  return {
    draft: name,
    dialogue_lines: dialogueCount,
    orphan_answers: orphans,
    narration_gaps: gaps,
    merged_cue_one_speaker: merged,
    echo_without_question: echoes,
    findings,
    verdict
  };
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const targets = args.includes('--all')
    ? fs.readdirSync(DRAFTS_DIR)
      .filter((n) => /^\d{8}[a-z]?-.+-(ko|ja)$/.test(n))
      .map((n) => path.join(DRAFTS_DIR, n))
    : [path.resolve(args.find((a) => !a.startsWith('--')) || '')];

  const results = targets.map(analyze);
  if (json) { console.log(JSON.stringify(results, null, 2)); return; }

  for (const r of results) {
    if (r.error) { console.log(`${r.draft}: ${r.error}`); continue; }
    if (args.includes('--all') && r.verdict === 'PASS') continue;
    console.log(`\n[${r.verdict}] ${r.draft} — 대사 ${r.dialogue_lines}줄 | 답만 남음 ${r.orphan_answers} · 되묻기 고아 ${r.echo_without_question} · 한큐한화자 ${r.merged_cue_one_speaker} · 해설 공백 ${r.narration_gaps}`);
    for (const f of r.findings.slice(0, 6)) {
      if (f.type === 'orphan_answer') {
        console.log(`   ${f.atSec.toFixed(1)}s 답만 남음 [${f.speaker}] "${f.kept.slice(0, 30)}"`);
        console.log(`        잘린 질문: "${f.droppedQuestion}"`);
      } else if (f.type === 'merged_cue_one_speaker') {
        console.log(`   ${f.atSec.toFixed(1)}s 한 큐를 [${f.speaker}] 혼자 말함 — "${f.kept}"`);
        console.log(`        원문 큐: "${f.sourceCue}"`);
      } else if (f.type === 'narration_gap') {
        console.log(`   ${f.atSec.toFixed(1)}s부터 ${f.gapSec}s 해설 없음 — 새 인물 ${f.newcomers.join(', ')}`);
      } else {
        console.log(`   ${f.atSec.toFixed(1)}s 되묻는데 질문이 없음 [${f.speaker}] "${f.kept.slice(0, 40)}"`);
      }
    }
  }
  if (args.includes('--all')) {
    const bad = results.filter((r) => r.verdict === 'FAIL').length;
    const warn = results.filter((r) => r.verdict === 'WARN').length;
    console.log(`\n총 ${results.length}편 | FAIL ${bad} / WARN ${warn} / PASS ${results.length - bad - warn}`);
  }
  if (results.some((r) => r.verdict === 'FAIL')) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { analyze, PAIR_GAP_MAX_SEC, ECHO_QUESTION };
