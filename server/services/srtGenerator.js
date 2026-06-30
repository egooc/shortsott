function formatSRTTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const ms = Math.round((safe % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
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

module.exports = { generateSRT, formatSRTTime };
