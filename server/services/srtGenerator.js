function formatSRTTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const ms = Math.round((safe % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function escapeSrtHeaderLine(value = '') {
  return String(value || '').replace(/\r?\n/g, ' ').trim();
}

function generateSRT(ttsResults) {
  let srt = '';
  let currentTime = 0;
  let seq = 1;

  ttsResults.forEach((seg) => {
    if (!seg.duration_sec || Number.isNaN(seg.duration_sec)) {
      console.warn(`Warning: no duration for ${seg.caption_id || seg.segment_id}, skipping`);
      return;
    }

    const startTime = formatSRTTime(currentTime);
    const endTime = formatSRTTime(currentTime + seg.duration_sec);

    srt += `${seq}\n`;
    srt += `${startTime} --> ${endTime}\n`;
    srt += `${seg.text}\n\n`;

    currentTime += seg.duration_sec;
    seq += 1;
  });

  return srt;
}

function generateSRTFromTimedEntries(entries = [], options = {}) {
  const warnings = Array.isArray(options.warnings) ? options.warnings.map(escapeSrtHeaderLine).filter(Boolean) : [];
  let srt = '';
  if (warnings.length) {
    srt += `NOTE Generated warnings\n`;
    warnings.forEach((warning) => {
      srt += `NOTE ${warning}\n`;
    });
    srt += `\n`;
  }

  let seq = 1;
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const text = String(entry?.text || '').trim();
    const startSec = Number(entry?.start_sec || 0);
    const endSec = Number(entry?.end_sec || 0);
    if (!text || !Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return;
    srt += `${seq}\n`;
    srt += `${formatSRTTime(startSec)} --> ${formatSRTTime(endSec)}\n`;
    srt += `${text}\n\n`;
    seq += 1;
  });
  return srt;
}

module.exports = { generateSRT, generateSRTFromTimedEntries, formatSRTTime };
