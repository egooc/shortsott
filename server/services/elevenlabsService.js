const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { createHttpError } = require('./errorService');
const { getAudioDuration } = require('../utils/ffprobe');

const OUTPUT_DIR = path.join(__dirname, '../output');
const TTS_ROOT = path.join(OUTPUT_DIR, 'tts');
const MIN_AUDIO_BYTES = 1024;
const MIN_DURATION_SEC = 0.2;
const MAX_RETRIES = 2;
const LONG_TEXT_WARNING_LENGTH = 1200;

if (!fs.existsSync(TTS_ROOT)) {
  fs.mkdirSync(TTS_ROOT, { recursive: true });
}

async function getVoices(apiKey) {
  const response = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': apiKey }
  });

  const data = await response.json();
  if (!response.ok) {
    throw createHttpError(response.status, 'ELEVENLABS_API_ERROR', `ElevenLabs API returned ${response.status}`, data);
  }

  return (data.voices || []).map((v) => ({
    voice_id: v.voice_id,
    name: v.name,
    preview_url: v.preview_url,
    labels: v.labels,
    category: v.category
  }));
}

async function ttsRequest(text, voiceId, modelId, apiKey) {
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text,
      model_id: modelId || 'eleven_v3',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75
      }
    })
  });

  if (!response.ok) {
    const textBody = await response.text();
    throw createHttpError(response.status, 'ELEVENLABS_API_ERROR', `ElevenLabs API returned ${response.status}`, { body: textBody });
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function ttsRequestWithMeta(text, voiceId, modelId, apiKey) {
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg'
    },
    body: JSON.stringify({
      text,
      model_id: modelId || 'eleven_v3',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75
      }
    })
  });

  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    const textBody = await response.text();
    return {
      ok: false,
      status: response.status,
      contentType,
      errorBody: textBody
    };
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    ok: true,
    status: response.status,
    contentType,
    buffer: Buffer.from(arrayBuffer)
  };
}

function createBatchDir() {
  const batchId = `batch_${Date.now()}`;
  const dir = path.join(TTS_ROOT, batchId);
  fs.mkdirSync(dir, { recursive: true });
  return { batchId, dir };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomRetryDelayMs() {
  return Math.floor(500 + Math.random() * 501);
}

function moveFailedFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const failedPath = `${filePath}.failed`;
  if (fs.existsSync(failedPath)) {
    fs.unlinkSync(failedPath);
  }
  fs.renameSync(filePath, failedPath);
}

function validateNarration(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length < 2) {
    return {
      valid: false,
      reason: 'empty_text',
      message: 'Segment narration is empty or too short.'
    };
  }

  const warnings = [];
  if (normalized.length > LONG_TEXT_WARNING_LENGTH) {
    warnings.push(`Narration length is long (${normalized.length} chars), TTS may be unstable.`);
  }

  return { valid: true, text: normalized, warnings };
}

function buildFailure(captionId, segmentId, reason, attempts, message) {
  return {
    caption_id: captionId,
    segment_id: segmentId,
    reason,
    attempts,
    message: message || ''
  };
}

async function synthesizeCaptionWithRetry(unit, voiceId, modelId, apiKey, outputDir) {
  const captionId = unit.caption_id || unit.captionId || `${unit.segment_id || unit.segmentId || 'caption'}_${Date.now()}`;
  const segmentId = unit.segment_id || unit.segmentId || '';
  const narration = unit.text || unit.narration || '';
  const narrationCheck = validateNarration(narration);

  if (!narrationCheck.valid) {
    return {
      success: false,
      failedSegment: buildFailure(captionId, segmentId, narrationCheck.reason, 0, narrationCheck.message),
      warnings: []
    };
  }

  const filename = `${captionId}.mp3`;
  const filePath = path.join(outputDir, filename);
  const warnings = (narrationCheck.warnings || []).map((message) => ({ caption_id: captionId, segment_id: segmentId, message }));

  let lastFailure = buildFailure(captionId, segmentId, 'unknown', 0, 'TTS generation failed');

  for (let retry = 0; retry <= MAX_RETRIES; retry += 1) {
    const attempts = retry + 1;
    try {
      const ttsResult = await ttsRequestWithMeta(narrationCheck.text, voiceId, modelId, apiKey);

      if (!ttsResult.ok || ttsResult.status !== 200) {
        lastFailure = buildFailure(
          captionId,
          segmentId,
          'http_error',
          attempts,
          `HTTP ${ttsResult.status}: ${ttsResult.errorBody || 'TTS request failed'}`
        );
        if (retry < MAX_RETRIES) {
          await sleep(randomRetryDelayMs());
          continue;
        }
        break;
      }

      if (ttsResult.contentType && !ttsResult.contentType.includes('audio')) {
        lastFailure = buildFailure(
          captionId,
          segmentId,
          'http_error',
          attempts,
          `Unexpected content-type: ${ttsResult.contentType}`
        );
        if (retry < MAX_RETRIES) {
          await sleep(randomRetryDelayMs());
          continue;
        }
        break;
      }

      fs.writeFileSync(filePath, ttsResult.buffer);
      const fileSize = fs.statSync(filePath).size;
      if (fileSize < MIN_AUDIO_BYTES) {
        moveFailedFile(filePath);
        lastFailure = buildFailure(
          captionId,
          segmentId,
          'zero_byte_file',
          attempts,
          `Generated file too small (${fileSize} bytes)`
        );
        if (retry < MAX_RETRIES) {
          await sleep(randomRetryDelayMs());
          continue;
        }
        break;
      }

      const duration = getAudioDuration(filePath);
      if (duration == null || Number.isNaN(duration)) {
        moveFailedFile(filePath);
        lastFailure = buildFailure(captionId, segmentId, 'ffprobe_failed', attempts, 'ffprobe failed to read duration');
        if (retry < MAX_RETRIES) {
          await sleep(randomRetryDelayMs());
          continue;
        }
        break;
      }

      if (duration < MIN_DURATION_SEC) {
        moveFailedFile(filePath);
        lastFailure = buildFailure(
          captionId,
          segmentId,
          'ffprobe_failed',
          attempts,
          `Audio duration too short (${duration.toFixed(3)} sec)`
        );
        if (retry < MAX_RETRIES) {
          await sleep(randomRetryDelayMs());
          continue;
        }
        break;
      }

      return {
        success: true,
        file: {
          caption_id: captionId,
          segment_id: segmentId,
          filename,
          filepath: filePath,
          duration_sec: duration,
          text: narrationCheck.text,
          success: true
        },
        warnings
      };
    } catch (error) {
      if (fs.existsSync(filePath)) {
        moveFailedFile(filePath);
      }
      lastFailure = buildFailure(captionId, segmentId, 'unknown', attempts, error.message || 'Unknown TTS error');
      if (retry < MAX_RETRIES) {
        await sleep(randomRetryDelayMs());
        continue;
      }
      break;
    }
  }

  return {
    success: false,
    failedSegment: lastFailure,
    warnings
  };
}

async function generateAllTTS(segments, voiceId, modelId, apiKey, outputDir) {
  const files = [];
  const failedSegments = [];
  const warnings = [];

  for (const seg of segments) {
    const segmentResult = await synthesizeCaptionWithRetry(seg, voiceId, modelId, apiKey, outputDir);
    if (segmentResult.success) {
      files.push(segmentResult.file);
    } else if (segmentResult.failedSegment) {
      failedSegments.push(segmentResult.failedSegment);
    }

    if (segmentResult.warnings?.length) {
      warnings.push(...segmentResult.warnings);
    }
  }

  return { files, failedSegments, warnings };
}

function zipDirectory(sourceDir, outPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

module.exports = {
  OUTPUT_DIR,
  TTS_ROOT,
  getVoices,
  ttsRequest,
  generateAllTTS,
  createBatchDir,
  zipDirectory,
  MIN_AUDIO_BYTES,
  MIN_DURATION_SEC
};
