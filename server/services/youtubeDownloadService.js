const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createHttpError } = require('./errorService');
const { resolveTool, findOnPath, getToolEnv } = require('../utils/toolPaths');

const YOUTUBE_URL_RE = /^https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i;

function resolveYtDlpCommand() {
  return resolveTool('yt-dlp', { envKey: 'YT_DLP_PATH' });
}

function findExecutable(command) {
  return findOnPath(command);
}

function getAvailableJsRuntime() {
  if (findExecutable(process.platform === 'win32' ? 'deno.exe' : 'deno')) return 'deno';
  if (findExecutable(process.platform === 'win32' ? 'node.exe' : 'node')) return 'node';
  return '';
}

function getPythonCommand() {
  return resolveTool('python', { envKey: 'PYTHON_PATH' }) || findExecutable('python3');
}

function parseYtDlpProgress(line) {
  const text = String(line || '').trim();
  if (!text.includes('[download]')) return null;
  const percentMatch = text.match(/(\d+(?:\.\d+)?)%/);
  if (!percentMatch) return null;
  const speedMatch = text.match(/\bat\s+([^\s]+\/s)/i);
  const etaMatch = text.match(/\bETA\s+([0-9:]+)/i);
  const sizeMatch = text.match(/of\s+([^\s]+)(?:\s+at|\s+ETA|$)/i);
  return {
    percent: Math.max(0, Math.min(100, Number(percentMatch[1]))),
    speed: speedMatch?.[1] || '',
    eta: etaMatch?.[1] || '',
    size: sizeMatch?.[1] || '',
    raw: text
  };
}

function classifyYoutubeDownloadError(error) {
  const details = error?.details || {};
  const combined = [
    error?.message,
    details.stderr,
    details.stdout,
    JSON.stringify(details.attempts || [])
  ].filter(Boolean).join('\n').toLowerCase();

  if (/private video|this video is private/.test(combined)) return 'private_video';
  if (/not available|video unavailable|has been removed|removed by/.test(combined)) return 'video_unavailable';
  if (/sign in|confirm.*not.*bot|cookies|login required/.test(combined)) return 'auth_or_cookies_required';
  if (/403|forbidden/.test(combined)) return 'forbidden_403';
  if (/429|too many requests|rate.?limit/.test(combined)) return 'rate_limited';
  if (/requested format is not available|format.*not available/.test(combined)) return 'format_unavailable';
  if (/timed out|timeout/.test(combined)) return 'timeout';
  if (/yt-dlp.*not found|enoent/.test(combined)) return 'yt_dlp_missing';
  if (/javascript runtime|js runtime|ejs/.test(combined)) return 'js_runtime_required';
  if (/pytubefix/.test(combined)) return 'fallback_failed';
  return 'unknown';
}

function runCommand(command, args, { timeoutMs = 20 * 60 * 1000, onProgress, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      env: getToolEnv()
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(createHttpError(504, 'YOUTUBE_DOWNLOAD_TIMEOUT', 'YouTube download timed out', {
        command,
        args,
        stdout: stdout.slice(-2000),
        stderr: stderr.slice(-4000)
      }));
    }, timeoutMs);

    const handleOutput = (streamName, chunk) => {
      const text = chunk.toString();
      if (streamName === 'stdout') stdout += text;
      else stderr += text;
      if (typeof onOutput === 'function') onOutput({ stream: streamName, text });
      for (const line of text.split(/\r?\n|\r/)) {
        const progress = parseYtDlpProgress(line);
        if (progress && typeof onProgress === 'function') {
          onProgress(progress);
        }
      }
    };

    child.stdout.on('data', (chunk) => handleOutput('stdout', chunk));
    child.stderr.on('data', (chunk) => handleOutput('stderr', chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        reject(createHttpError(500, 'YT_DLP_NOT_FOUND', 'yt-dlp is required for YouTube URL download. Install yt-dlp and make sure it is available on PATH.', {
          command
        }));
        return;
      }
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const error = createHttpError(500, 'YOUTUBE_DOWNLOAD_FAILED', `yt-dlp exited with code ${code}`, {
          command,
          args,
          exitCode: code,
          stdout: stdout.slice(-2000),
          stderr: stderr.slice(-4000)
        });
        error.details.errorType = classifyYoutubeDownloadError(error);
        reject(error);
        return;
      }
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

function cleanupPreviousSourceFiles(targetPath) {
  const dir = path.dirname(targetPath);
  const parsed = path.parse(targetPath);
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name === path.basename(targetPath) || entry.name.startsWith(`${parsed.name}.`)) {
      fs.rmSync(path.join(dir, entry.name), { force: true });
    }
  }
}

function buildYtDlpArgs({ normalizedUrl, outputTemplate, jsRuntime = '', cookiesBrowser = '', remoteComponents = '' }) {
  const args = [
    '--no-playlist',
    '--newline',
    '--restrict-filenames',
    '--sleep-requests',
    '1.5',
    '--sleep-interval',
    '2',
    '--max-sleep-interval',
    '6',
    '--force-overwrites'
  ];

  if (jsRuntime) {
    args.push('--js-runtimes', jsRuntime);
  }

  if (remoteComponents) {
    args.push('--remote-components', remoteComponents);
  }

  if (cookiesBrowser) {
    args.push('--cookies-from-browser', cookiesBrowser);
  }

  args.push(
    '-f',
    'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best[ext=mp4]/best',
    '--merge-output-format',
    'mp4',
    '-o',
    outputTemplate,
    normalizedUrl
  );

  return args;
}

function validateDownloadedMp4(mp4Path, result) {
  if (!fs.existsSync(mp4Path) || fs.statSync(mp4Path).size < 1024) {
    throw createHttpError(500, 'YOUTUBE_DOWNLOAD_OUTPUT_MISSING', 'Downloaded YouTube video file was not created or is too small.', {
      expectedPath: mp4Path,
      stdout: result.stdout?.slice(-2000) || '',
      stderr: result.stderr?.slice(-4000) || ''
    });
  }
}

async function runYtDlpAttempt({ name, normalizedUrl, targetPath, outputTemplate, jsRuntime = '', cookiesBrowser = '', remoteComponents = '', onProgress }) {
  cleanupPreviousSourceFiles(targetPath);
  const command = resolveYtDlpCommand();
  const args = buildYtDlpArgs({ normalizedUrl, outputTemplate, jsRuntime, cookiesBrowser, remoteComponents });
  if (typeof onProgress === 'function') {
    onProgress({ percent: 0, speed: '', eta: '', size: '', method: name, phase: 'attempt_start' });
  }
  const result = await runCommand(command, args, {
    onProgress: (progress) => {
      if (typeof onProgress === 'function') onProgress({ ...progress, method: name, phase: 'downloading' });
    }
  });
  const parsed = path.parse(targetPath);
  const mp4Path = path.join(parsed.dir, `${parsed.name}.mp4`);
  validateDownloadedMp4(mp4Path, result);

  return {
    status: 'success',
    method: name,
    url: normalizedUrl,
    outputPath: mp4Path,
    filename: path.basename(mp4Path),
    stdout: result.stdout.slice(-2000),
    stderr: result.stderr.slice(-4000)
  };
}

async function runPytubefixAttempt({ normalizedUrl, targetPath, onProgress }) {
  const pythonCommand = getPythonCommand();
  const scriptPath = path.join(__dirname, '../../scripts/youtube_download_pytubefix.py');
  if (!pythonCommand || !fs.existsSync(scriptPath)) {
    const error = createHttpError(500, 'PYTUBEFIX_FALLBACK_UNAVAILABLE', 'pytubefix fallback is not available', {
      pythonCommand: pythonCommand || '',
      scriptPath
    });
    throw error;
  }

  cleanupPreviousSourceFiles(targetPath);
  if (typeof onProgress === 'function') {
    onProgress({ percent: 0, speed: '', eta: '', size: '', method: 'pytubefix', phase: 'attempt_start' });
  }
  const result = await runCommand(pythonCommand, [
    scriptPath,
    '--url',
    normalizedUrl,
    '--output',
    targetPath
  ]);
  validateDownloadedMp4(targetPath, result);
  if (typeof onProgress === 'function') {
    onProgress({ percent: 100, speed: '', eta: '', size: '', method: 'pytubefix', phase: 'finished' });
  }
  return {
    status: 'success',
    method: 'pytubefix',
    url: normalizedUrl,
    outputPath: targetPath,
    filename: path.basename(targetPath),
    stdout: result.stdout.slice(-2000),
    stderr: result.stderr.slice(-4000)
  };
}

function summarizeAttemptError(name, error) {
  return {
    name,
    code: error.code || 'UNKNOWN',
    status: error.status || 500,
    errorType: error.details?.errorType || classifyYoutubeDownloadError(error),
    message: error.message,
    details: {
      ...(error.details || {}),
      stdout: error.details?.stdout ? String(error.details.stdout).slice(-1200) : '',
      stderr: error.details?.stderr ? String(error.details.stderr).slice(-2000) : ''
    }
  };
}

async function downloadYoutubeVideo({ url, targetPath, onProgress }) {
  const normalizedUrl = String(url || '').trim();
  if (!YOUTUBE_URL_RE.test(normalizedUrl)) {
    throw createHttpError(400, 'YOUTUBE_URL_INVALID', 'A valid YouTube URL is required.');
  }
  if (!targetPath) {
    throw createHttpError(400, 'YOUTUBE_TARGET_PATH_REQUIRED', 'targetPath is required.');
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const parsed = path.parse(targetPath);
  const outputTemplate = path.join(parsed.dir, `${parsed.name}.%(ext)s`);
  const jsRuntime = getAvailableJsRuntime();
  const cookiesBrowser = String(process.env.YTDLP_COOKIES_FROM_BROWSER || '').trim();
  const attempts = [];

  if (jsRuntime) {
    attempts.push({
      name: `yt-dlp-${jsRuntime}-runtime`,
      runner: () => runYtDlpAttempt({ name: `yt-dlp-${jsRuntime}-runtime`, normalizedUrl, targetPath, outputTemplate, jsRuntime, onProgress })
    });
    attempts.push({
      name: `yt-dlp-${jsRuntime}-runtime-remote-ejs`,
      runner: () => runYtDlpAttempt({
        name: `yt-dlp-${jsRuntime}-runtime-remote-ejs`,
        normalizedUrl,
        targetPath,
        outputTemplate,
        jsRuntime,
        remoteComponents: 'ejs:github',
        onProgress
      })
    });
  }

  if (cookiesBrowser) {
    attempts.push({
      name: `yt-dlp-${jsRuntime || 'default'}-runtime-cookies`,
      runner: () => runYtDlpAttempt({ name: `yt-dlp-${jsRuntime || 'default'}-runtime-cookies`, normalizedUrl, targetPath, outputTemplate, jsRuntime, cookiesBrowser, onProgress })
    });
  }

  attempts.push({
    name: 'yt-dlp-default',
    runner: () => runYtDlpAttempt({ name: 'yt-dlp-default', normalizedUrl, targetPath, outputTemplate, onProgress })
  });

  attempts.push({
    name: 'pytubefix',
    runner: () => runPytubefixAttempt({ normalizedUrl, targetPath, onProgress })
  });

  const failures = [];
  for (const attempt of attempts) {
    try {
      const result = await attempt.runner();
      if (typeof onProgress === 'function') {
        onProgress({ percent: 100, speed: '', eta: '', size: '', method: result.method || attempt.name, phase: 'finished' });
      }
      return {
        ...result,
        attempts: failures.concat([{ name: attempt.name, status: 'success' }])
      };
    } catch (error) {
      failures.push(summarizeAttemptError(attempt.name, error));
    }
  }

  const error = createHttpError(500, 'YOUTUBE_DOWNLOAD_FAILED_ALL', 'All YouTube download methods failed.', {
    url: normalizedUrl,
    jsRuntime: jsRuntime || 'none',
    cookiesBrowser: cookiesBrowser || '',
    attempts: failures,
    errorType: failures[failures.length - 1]?.errorType || 'unknown'
  });
  error.details.errorType = error.details.errorType || classifyYoutubeDownloadError(error);
  throw error;
}

module.exports = {
  downloadYoutubeVideo,
  parseYtDlpProgress,
  classifyYoutubeDownloadError
};
