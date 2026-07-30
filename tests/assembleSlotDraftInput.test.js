const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

test('dialogue utterance validation accepts padded visual clips with exact speech range metadata', () => {
  const scriptPath = path.join(__dirname, '..', 'midform', 'scripts', 'assemble_slot_draft_input.py');
  const code = `
import importlib.util

spec = importlib.util.spec_from_file_location("assemble_slot_draft_input", ${JSON.stringify(scriptPath)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

mod.validate_dialogue_utterance_references([
    {
        "segment_id": "slot_01_L01",
        "segment_type": "dialogue_quote",
        "utt_id": "slot_01_L01",
        "dialogue_speech_range_sec": [173.43, 178.55],
        "source_scenes": [{"start": "00:02:52.930", "end": "00:02:58.700"}],
    }
], {"utterances": [{"utt_id": "slot_01_L01", "start": 173.43, "end": 178.55, "text": "I am Paul"}]})
`;

  const result = spawnSync('python', ['-c', code], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('dialogue utterance validation rejects mismatched speech range metadata', () => {
  const scriptPath = path.join(__dirname, '..', 'midform', 'scripts', 'assemble_slot_draft_input.py');
  const code = `
import importlib.util

spec = importlib.util.spec_from_file_location("assemble_slot_draft_input", ${JSON.stringify(scriptPath)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

try:
    mod.validate_dialogue_utterance_references([
        {
            "segment_id": "slot_01_L01",
            "segment_type": "dialogue_quote",
            "utt_id": "slot_01_L01",
            "dialogue_speech_range_sec": [173.43, 178.55],
            "source_scenes": [{"start": "00:02:52.930", "end": "00:02:58.700"}],
        }
    ], {"utterances": [{"utt_id": "slot_01_L01", "start": 170.0, "end": 172.0, "text": "different line"}]})
except ValueError as exc:
    raise SystemExit(0 if "DIALOGUE_UTTERANCE_REFERENCE_FAILED" in str(exc) else 1)
raise SystemExit(1)
`;

  const result = spawnSync('python', ['-c', code], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
