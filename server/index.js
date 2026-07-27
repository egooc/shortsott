const path = require('path');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { ensureProjectFolders } = require('./services/pipelinePaths');

const settingsRoutes = require('./routes/settings');
const geminiMidformRouter = require('./routes/gemini_midform');
const gptMidformRouter = require('./routes/gpt_midform');
const midformPipelineRouter = require('./routes/midform_pipeline');
const midformMaterialsRouter = require('./routes/midform_materials');
const capcutRoutes = require('./routes/capcut');
// Claude midform route is intentionally kept on disk but not registered.
// GPT/Codex is the primary sealed-run path; re-register only if that path is restored.
// const claudeMidformRouter = require('./routes/claude_midform');

dotenv.config({ path: path.join(__dirname, '../.env') });
ensureProjectFolders();

function maskProjectId(value) {
  const text = String(value || '').trim();
  if (!text) return '(empty)';
  if (text.length <= 10) return `${text.slice(0, 3)}***`;
  return `${text.slice(0, 6)}***${text.slice(-4)}`;
}

function logVertexEnvSummary() {
  const authMode = String(process.env.GEMINI_AUTH_MODE || '').trim() || '(empty)';
  const project = String(process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '').trim();
  const location = String(process.env.GOOGLE_CLOUD_LOCATION || '').trim() || '(empty)';
  const model = String(process.env.VERTEX_GEMINI_MODEL || '').trim() || '(empty)';
  console.log(`[startup.vertex] auth_mode=${authMode} project=${maskProjectId(project)} location=${location} model=${model}`);
}

logVertexEnvSummary();

const app = express();
const DEFAULT_PORT = process.env.PORT || 3001;
const DEFAULT_HOST = process.env.HOST || process.env.MIDFORM_HOST || '127.0.0.1';

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return true;
  const configured = String(process.env.MIDFORM_ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
  return configured.includes(origin);
}

app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error(`CORS origin not allowed: ${origin}`));
  }
}));
app.use(express.json({ limit: '10mb' }));
app.use('/output', express.static(path.join(__dirname, 'output')));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.use('/api/settings', settingsRoutes);
app.use('/api/midform/gemini', geminiMidformRouter);
// app.use('/api/midform/claude', claudeMidformRouter);
app.use('/api/midform/gpt', gptMidformRouter);
app.use('/api/midform/pipeline', midformPipelineRouter);
app.use('/api/midform', midformMaterialsRouter);
app.use('/api/capcut', capcutRoutes);

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  return res.status(404).json({
    error: true,
    message: 'Midform server is API-only. Client UI was archived in Phase 3 cleanup.',
    code: 'MIDFORM_API_ONLY',
    details: {}
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({
    error: true,
    message: err.message || 'Internal server error',
    code: err.code || 'INTERNAL_ERROR',
    details: err.details || {}
  });
});

function startServer(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const address = server.address();
      const resolvedPort = typeof address === 'object' && address ? address.port : port;
      const resolvedHost = typeof address === 'object' && address ? address.address : host;
      console.log(`Server running on http://${resolvedHost}:${resolvedPort}`);
      resolve({ app, server, port: resolvedPort, host: resolvedHost });
    });

    server.on('error', reject);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { app, startServer };
