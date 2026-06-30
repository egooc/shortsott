const express = require('express');
const { spawn } = require('child_process');
const { readEnvMap, writeEnvMap, maskSecret } = require('../services/envService');
const { requireApiKey } = require('../middleware/auth');
const { virloRequest } = require('../services/virloService');
const { testVertexAdcConnection } = require('../services/processMetadataService');
const { testYouTubeUploadAuth } = require('../services/youtubeUploadService');

const router = express.Router();

const ALLOWED_KEYS = [
  'VIRLO_API_KEY',
  'GEMINI_AUTH_MODE',
  'GEMINI_API_KEY',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'VERTEX_GEMINI_MODEL',
  'YOUTUBE_API_KEY',
  'YOUTUBE_OAUTH_CLIENT_ID',
  'YOUTUBE_OAUTH_CLIENT_SECRET',
  'YOUTUBE_OAUTH_REDIRECT_URI',
  'YOUTUBE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_API_KEY',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_OAUTH_TOKEN',
  'ELEVENLABS_API_KEY'
];

const PLAIN_KEYS = new Set([
  'GEMINI_AUTH_MODE',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'VERTEX_GEMINI_MODEL',
  'YOUTUBE_OAUTH_CLIENT_ID',
  'YOUTUBE_OAUTH_REDIRECT_URI'
]);

function formatSettingValue(key, value) {
  return PLAIN_KEYS.has(key) ? String(value || '') : maskSecret(value || '');
}

function getClaudeCliToken(envMap) {
  return (
    envMap.CLAUDE_CODE_OAUTH_TOKEN ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    envMap.CLAUDE_OAUTH_TOKEN ||
    process.env.CLAUDE_OAUTH_TOKEN ||
    ''
  );
}

function getClaudeApiKey(envMap) {
  return (
    envMap.CLAUDE_API_KEY ||
    process.env.CLAUDE_API_KEY ||
    envMap.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    ''
  );
}

function runClaudeCliOAuthTest(token) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env };
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.ANTHROPIC_AUTH_TOKEN;
    childEnv.CLAUDE_CODE_OAUTH_TOKEN = token;
    childEnv.CLAUDE_OAUTH_TOKEN = token;

    const isWindows = process.platform === 'win32';
    const command = 'claude -p \'JSON only. Output {"ok":true}\'';
    const bin = isWindows ? 'powershell.exe' : 'claude';
    const args = isWindows
      ? ['-NoProfile', '-Command', command]
      : ['-p', 'JSON only. Output {"ok":true}'];

    const child = spawn(bin, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject({
        exitCode: null,
        stderr,
        stdout,
        message: `Failed to start claude CLI: ${error.message}`,
        command
      });
    });

    child.on('close', (code) => {
      const out = String(stdout || '').trim();
      const okFound = /"ok"\s*:\s*true/.test(out);
      if (code === 0 && okFound) {
        resolve({ ok: true });
        return;
      }

      reject({
        exitCode: code,
        stderr: String(stderr || '').trim(),
        stdout: out,
        message: 'Claude CLI OAuth test failed',
        command
      });
    });
  });
}

router.get('/', (_req, res) => {
  const envMap = readEnvMap();
  const masked = {};
  ALLOWED_KEYS.forEach((key) => {
    if (key === 'CLAUDE_API_KEY') {
      masked[key] = maskSecret(getClaudeApiKey(envMap));
      return;
    }
    masked[key] = formatSettingValue(key, envMap[key] || process.env[key] || '');
  });
  res.json(masked);
});

router.post('/', (req, res) => {
  const { key, value } = req.body || {};
  if (!ALLOWED_KEYS.includes(key)) {
    return res.status(400).json({ error: true, message: 'Invalid key', code: 'INVALID_KEY', details: { key } });
  }

  const envMap = readEnvMap();
  envMap[key] = String(value || '');

  if (key === 'CLAUDE_API_KEY') {
    envMap.ANTHROPIC_API_KEY = envMap[key];
  }
  if (key === 'ANTHROPIC_API_KEY') {
    envMap.CLAUDE_API_KEY = envMap[key];
  }

  writeEnvMap(envMap);
  process.env[key] = envMap[key];
  if (key === 'CLAUDE_API_KEY') process.env.ANTHROPIC_API_KEY = envMap.ANTHROPIC_API_KEY || '';
  if (key === 'ANTHROPIC_API_KEY') process.env.CLAUDE_API_KEY = envMap.CLAUDE_API_KEY || '';

  return res.json({ ok: true, key, maskedValue: formatSettingValue(key, envMap[key]) });
});

router.post('/migrate-legacy-claude-token', (req, res) => {
  const envMap = readEnvMap();
  const legacy = envMap.CLAUDE_OAUTH_TOKEN || process.env.CLAUDE_OAUTH_TOKEN || '';
  if (!legacy) {
    return res.status(400).json({
      error: true,
      message: 'Legacy Claude OAuth token not found',
      code: 'LEGACY_TOKEN_NOT_FOUND',
      details: { key: 'CLAUDE_OAUTH_TOKEN' }
    });
  }

  envMap.CLAUDE_CODE_OAUTH_TOKEN = legacy;
  writeEnvMap(envMap);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = legacy;

  return res.json({
    ok: true,
    message: 'Legacy token copied to CLAUDE_CODE_OAUTH_TOKEN',
    maskedValue: maskSecret(legacy)
  });
});

router.post('/test', async (req, res, next) => {
  try {
    const { key } = req.body || {};
    if (!ALLOWED_KEYS.includes(key)) {
      return res.status(400).json({ error: true, message: 'Invalid key', code: 'INVALID_KEY', details: { key } });
    }

    if (key === 'VIRLO_API_KEY') {
      const virloApiKey = requireApiKey('VIRLO_API_KEY');
      const result = await virloRequest('/orbit?limit=1', virloApiKey);
      return res.json({
        status: 'ok',
        info: 'Virlo connected',
        details: { sample: Array.isArray(result?.data) ? result.data.length : undefined }
      });
    }

    if (key === 'GEMINI_AUTH_MODE' || key === 'GOOGLE_CLOUD_PROJECT' || key === 'GOOGLE_CLOUD_LOCATION' || key === 'VERTEX_GEMINI_MODEL') {
      const envMap = readEnvMap();
      if (String(envMap.GEMINI_AUTH_MODE || process.env.GEMINI_AUTH_MODE || '').trim().toLowerCase() !== 'vertex_adc') {
        return res.json({ status: 'ok', info: 'Gemini auth mode is not Vertex ADC' });
      }

      const result = await testVertexAdcConnection();
      return res.json(result);
    }

    if (key === 'GEMINI_API_KEY') {
      const geminiApiKey = requireApiKey('GEMINI_API_KEY');
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiApiKey}`);
      const data = await response.json();
      if (!response.ok) {
        return res.status(response.status).json({
          error: true,
          message: 'Gemini test failed',
          code: 'GEMINI_TEST_FAILED',
          details: data
        });
      }
      return res.json({ status: 'ok', info: 'Gemini connected' });
    }

    if (key === 'YOUTUBE_API_KEY') {
      const youtubeApiKey = requireApiKey('YOUTUBE_API_KEY');
      const response = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=%23shorts&key=${youtubeApiKey}`);
      const data = await response.json();
      if (!response.ok) {
        return res.status(response.status).json({
          error: true,
          message: 'YouTube API test failed',
          code: 'YOUTUBE_API_TEST_FAILED',
          details: data
        });
      }
      return res.json({ status: 'ok', info: 'YouTube Data API connected' });
    }

    if (
      key === 'YOUTUBE_OAUTH_CLIENT_ID' ||
      key === 'YOUTUBE_OAUTH_CLIENT_SECRET' ||
      key === 'YOUTUBE_OAUTH_REDIRECT_URI' ||
      key === 'YOUTUBE_OAUTH_REFRESH_TOKEN'
    ) {
      const result = await testYouTubeUploadAuth();
      return res.json(result);
    }

    if (key === 'CLAUDE_API_KEY' || key === 'ANTHROPIC_API_KEY') {
      const envMap = readEnvMap();
      const claudeApiKey = getClaudeApiKey(envMap);
      if (!claudeApiKey) {
        return res.status(400).json({
          error: true,
          message: 'Claude API key is missing',
          code: 'CLAUDE_API_KEY_MISSING',
          details: { expectedKeys: ['CLAUDE_API_KEY', 'ANTHROPIC_API_KEY'] }
        });
      }
      const response = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': claudeApiKey,
          'anthropic-version': '2023-06-01'
        }
      });
      const data = await response.json();
      if (!response.ok) {
        return res.status(response.status).json({
          error: true,
          message: 'Claude API key test failed',
          code: 'CLAUDE_API_KEY_TEST_FAILED',
          details: data
        });
      }
      return res.json({ status: 'ok', info: 'Claude API key connected' });
    }

    if (key === 'CLAUDE_CODE_OAUTH_TOKEN' || key === 'CLAUDE_OAUTH_TOKEN') {
      const envMap = readEnvMap();
      const token = getClaudeCliToken(envMap);
      if (!token) {
        return res.status(400).json({
          error: true,
          message: 'Claude OAuth token is missing',
          code: 'CLAUDE_OAUTH_TOKEN_MISSING',
          details: { expectedKeys: ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_OAUTH_TOKEN'] }
        });
      }

      try {
        await runClaudeCliOAuthTest(token);
        return res.json({ status: 'ok', info: 'Claude connected (CLI OAuth)' });
      } catch (testError) {
        const summary = `cmd=${testError.command || 'claude -p "JSON only. Output {\\"ok\\":true}"'} reason=${testError.message || '(unknown)'} exit=${testError.exitCode ?? 'n/a'} stderr=${testError.stderr || '(empty)'} stdout=${testError.stdout || '(empty)'}`;
        return res.status(500).json({
          error: true,
          message: 'Claude CLI OAuth test failed',
          code: 'CLAUDE_CLI_TEST_FAILED',
          details: {
            exitCode: testError.exitCode,
            stderr: testError.stderr || '',
            stdout: testError.stdout || '',
            summary
          }
        });
      }
    }

    if (key === 'ELEVENLABS_API_KEY') {
      const elevenlabsApiKey = requireApiKey('ELEVENLABS_API_KEY');
      const response = await fetch('https://api.elevenlabs.io/v1/user', {
        headers: { 'xi-api-key': elevenlabsApiKey }
      });
      const data = await response.json();
      if (!response.ok) {
        return res.status(response.status).json({
          error: true,
          message: 'ElevenLabs test failed',
          code: 'ELEVENLABS_TEST_FAILED',
          details: data
        });
      }
      const quotaInfo = data.subscription ? `Chars used: ${data.subscription.character_count || 0}` : 'Connected';
      return res.json({ status: 'ok', info: quotaInfo });
    }

    return res.json({ status: 'ok' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
