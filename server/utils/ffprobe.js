const { execFileSync } = require('child_process');
const { resolveTool } = require('./toolPaths');

function ffprobePath() {
  return resolveTool('ffprobe', { envKey: 'FFPROBE_PATH' });
}

function getAudioDuration(filePath) {
  try {
    const result = execFileSync(ffprobePath(), ['-v', 'quiet', '-print_format', 'json', '-show_format', filePath], { encoding: 'utf-8' });
    const data = JSON.parse(result);
    return parseFloat(data?.format?.duration);
  } catch (error) {
    console.error('ffprobe error:', error.message);
    return null;
  }
}

function getVideoMetadata(filePath) {
  try {
    const result = execFileSync(ffprobePath(), ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', filePath], { encoding: 'utf-8' });
    const data = JSON.parse(result);
    const videoStream = (data?.streams || []).find((stream) => stream.codec_type === 'video') || {};
    const duration = parseFloat(data?.format?.duration || videoStream.duration || 0);
    const fpsParts = String(videoStream.avg_frame_rate || videoStream.r_frame_rate || '').split('/');
    const fps = fpsParts.length === 2 && Number(fpsParts[1])
      ? Number(fpsParts[0]) / Number(fpsParts[1])
      : null;
    return {
      duration_sec: Number.isFinite(duration) && duration > 0 ? duration : null,
      width: Number(videoStream.width) || null,
      height: Number(videoStream.height) || null,
      fps: Number.isFinite(fps) && fps > 0 ? Number(fps.toFixed(3)) : null,
      codec: videoStream.codec_name || ''
    };
  } catch (error) {
    console.error('ffprobe video error:', error.message);
    return {
      duration_sec: null,
      width: null,
      height: null,
      fps: null,
      codec: '',
      error: error.message
    };
  }
}

module.exports = { getAudioDuration, getVideoMetadata };
