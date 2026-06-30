const path = require('path');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { ensureProjectFolders } = require('./services/pipelinePaths');
const { recoverProcessJobsOnStartup } = require('./services/processJobService');

const settingsRoutes = require('./routes/settings');
const virloRoutes = require('./routes/virlo');
const geminiRoutes = require('./routes/gemini');
const claudeRoutes = require('./routes/claude');
const elevenlabsRoutes = require('./routes/elevenlabs');
const capcutRoutes = require('./routes/capcut');
const processEditRoutes = require('./routes/processEdit');
const processQueueRoutes = require('./routes/processQueue');
const youtubeRoutes = require('./routes/youtube');
const youtubeUploadRoutes = require('./routes/youtubeUpload');

dotenv.config({ path: path.join(__dirname, '../.env') });
ensureProjectFolders();

const app = express();
const DEFAULT_PORT = process.env.PORT || 3001;
let recoveredProcessJobs = { recovered: [], skipped: [] };
let recoveryHasRun = false;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/output', express.static(path.join(__dirname, 'output')));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.use('/api/settings', settingsRoutes);
app.use('/api/virlo', virloRoutes);
app.use('/api/gemini', geminiRoutes);
app.use('/api/claude', claudeRoutes);
app.use('/api/elevenlabs', elevenlabsRoutes);
app.use('/api/capcut', capcutRoutes);
app.use('/api/process-edit', processEditRoutes);
app.use('/api/process-queue', processQueueRoutes);
app.use('/api/youtube', youtubeRoutes);
app.use('/api/youtube-upload', youtubeUploadRoutes);

const clientDistPath = path.join(__dirname, '../client/dist');
app.use(express.static(clientDistPath));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  return res.sendFile(path.join(clientDistPath, 'index.html'), (error) => {
    if (error) next();
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

function runStartupRecoveryOnce() {
  if (recoveryHasRun) return recoveredProcessJobs;
  recoveryHasRun = true;
  recoveredProcessJobs = recoverProcessJobsOnStartup();
  return recoveredProcessJobs;
}

function startServer(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  runStartupRecoveryOnce();

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      const address = server.address();
      const resolvedPort = typeof address === 'object' && address ? address.port : port;
      console.log(`Server running on http://localhost:${resolvedPort}`);
      if (recoveredProcessJobs.recovered.length) {
        console.log(`Recovered process jobs: ${recoveredProcessJobs.recovered.map((job) => `${job.job_id}:${job.worker_pid}`).join(', ')}`);
      }
      resolve({ app, server, port: resolvedPort, recoveredProcessJobs });
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
