const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const {
  getAuthorizationUrl,
  exchangeOAuthCode,
  testYouTubeUploadAuth,
  createYouTubeUploadProfile,
  listYouTubeUploadProfiles,
  setActiveYouTubeUploadProfile,
  updateYouTubeUploadProfile,
  deleteYouTubeUploadProfile,
  listDraftUploadCandidates,
  importUploadFiles,
  listUploadHistory,
  listPendingUploads,
  restorePendingUploads,
  saveManualPendingUploads,
  saveManualCompletedUploads,
  listUploadCards,
  restoreUploadCards,
  deleteUploadCard,
  deleteUploadCardsByDate,
  listUploadJobs,
  loadJob,
  createUploadJob,
  startUploadJob,
  requestCancelUploadJob
} = require('../services/youtubeUploadService');
const { PROJECT_ROOT } = require('../services/pipelinePaths');

const router = express.Router();
const UPLOAD_TMP_DIR = path.join(PROJECT_ROOT, 'server', 'data', 'youtube_upload_tmp');
const IMPORTS_DIR = path.join(PROJECT_ROOT, 'server', 'data', 'youtube_upload_imports');
const MAX_UPLOAD_IMPORT_FILES = 300;
if (!fs.existsSync(UPLOAD_TMP_DIR)) fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });

function repairUploadOriginalName(name) {
  const raw = String(name || '');
  const hasReadableUnicode = /[\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(raw);
  const looksMojibake = raw.includes(String.fromCharCode(0xfffd))
    || /[\xc3\xc2\xe3\xe4\xe5\xe6\xe7\xe8\xe9\xec\xed\xee\xef\xf0\xf1\xf2\xf3\xf4\xf5\xf6\xf8\xf9\xfa\xfb\xfc\xfd\xfe\xff]/.test(raw);
  if (hasReadableUnicode && !looksMojibake) return raw.normalize('NFC');
  try {
    const repaired = Buffer.from(raw, 'latin1').toString('utf8');
    const repairedReadableUnicode = /[\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(repaired);
    if (repairedReadableUnicode && !repaired.includes(String.fromCharCode(0xfffd))) return repaired.normalize('NFC');
  } catch {
    // Keep the original name.
  }
  return raw.normalize('NFC');
}

function isUploadVideo(file) {
  const name = repairUploadOriginalName(file.originalname).toLowerCase();
  const mime = String(file.mimetype || '').toLowerCase();
  return mime.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(name);
}

function isUploadText(file) {
  const name = repairUploadOriginalName(file.originalname).toLowerCase();
  const mime = String(file.mimetype || '').toLowerCase();
  return /\.txt$/i.test(name) || mime === 'text/plain' || mime === 'application/octet-stream' && /\.txt$/i.test(name);
}

const upload = multer({
  dest: UPLOAD_TMP_DIR,
  limits: { fileSize: 8 * 1024 * 1024 * 1024, files: MAX_UPLOAD_IMPORT_FILES },
  fileFilter: (_req, file, cb) => {
    if (isUploadVideo(file) || isUploadText(file)) {
      cb(null, true);
      return;
    }
    cb(new Error('Only video files and .txt metadata files are allowed'));
  }
});

function uploadImportFiles(req, res, next) {
  upload.array('files', MAX_UPLOAD_IMPORT_FILES)(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_COUNT') {
      res.status(400).json({
        error: true,
        code: 'UPLOAD_FILE_COUNT_LIMIT',
        message: `Too many files. Upload up to ${MAX_UPLOAD_IMPORT_FILES} video/TXT files at once.`
      });
      return;
    }

    next(error);
  });
}

router.get('/oauth-url', (req, res, next) => {
  try {
    res.json(getAuthorizationUrl({
      profileId: req.query.profileId,
      profileName: req.query.profileName
    }));
  } catch (error) {
    next(error);
  }
});

router.get('/profiles', (_req, res, next) => {
  try {
    res.json(listYouTubeUploadProfiles());
  } catch (error) {
    next(error);
  }
});

router.post('/profiles', (req, res, next) => {
  try {
    res.status(201).json(createYouTubeUploadProfile(req.body || {}));
  } catch (error) {
    next(error);
  }
});

router.post('/profiles/active', (req, res, next) => {
  try {
    res.json(setActiveYouTubeUploadProfile(req.body?.profileId || ''));
  } catch (error) {
    next(error);
  }
});

router.patch('/profiles/:profileId', (req, res, next) => {
  try {
    res.json(updateYouTubeUploadProfile(req.params.profileId, req.body || {}));
  } catch (error) {
    next(error);
  }
});

router.delete('/profiles/:profileId', (req, res, next) => {
  try {
    res.json(deleteYouTubeUploadProfile(req.params.profileId));
  } catch (error) {
    next(error);
  }
});

router.get('/preview/*', (req, res, next) => {
  try {
    const relativePath = decodeURIComponent(req.params[0] || '');
    const targetPath = path.resolve(IMPORTS_DIR, relativePath);
    const rootPath = path.resolve(IMPORTS_DIR);
    const relativeToRoot = path.relative(rootPath, targetPath);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot) || !fs.existsSync(targetPath)) {
      return res.status(404).json({ error: true, message: 'Preview video not found' });
    }
    const ext = path.extname(targetPath).toLowerCase();
    const mime = ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4';
    const stat = fs.statSync(targetPath);
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunkSize = (end - start) + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mime
      });
      return fs.createReadStream(targetPath, { start, end }).pipe(res);
    }
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Type', mime);
    return fs.createReadStream(targetPath).pipe(res);
  } catch (error) {
    next(error);
  }
});

router.get('/oauth/callback', async (req, res, next) => {
  try {
    const code = String(req.query.code || '');
    if (!code) {
      return res.status(400).send('<h1>YouTube OAuth failed</h1><p>Missing authorization code.</p>');
    }
    const result = await exchangeOAuthCode(code, req.query.state || '');
    return res.send(`
      <html>
        <head><meta charset="utf-8"><title>YouTube OAuth Connected</title></head>
        <body style="font-family: sans-serif; padding: 32px;">
          <h1>YouTube OAuth connected</h1>
          <p>Refresh token saved: ${result.maskedRefreshToken}</p>
          <p>Profile: ${result.profile?.name || ''}</p>
          <p>Channel: ${result.profile?.channelTitle || ''}</p>
          <p>You can close this window and return to the app.</p>
        </body>
      </html>
    `);
  } catch (error) {
    next(error);
  }
});

router.post('/test-auth', async (req, res, next) => {
  try {
    const result = await testYouTubeUploadAuth(req.body?.profileId || req.query.profileId || '');
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/drafts', (_req, res, next) => {
  try {
    res.json(listDraftUploadCandidates());
  } catch (error) {
    next(error);
  }
});

router.post('/import-files', uploadImportFiles, (req, res, next) => {
  try {
    const files = req.files || [];
    const videoFiles = files.filter(isUploadVideo);
    const metadataFiles = files.filter(isUploadText);
    if (!videoFiles.length) {
      return res.status(400).json({ error: true, message: 'No video files uploaded', code: 'NO_VIDEO_FILES' });
    }
    const result = importUploadFiles({ videoFiles, metadataFiles });
    return res.json(result);
  } catch (error) {
    next(error);
  } finally {
    for (const file of req.files || []) {
      try {
        if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
      } catch {
        // Ignore temp cleanup errors.
      }
    }
  }
});

router.get('/jobs', (_req, res, next) => {
  try {
    res.json({ jobs: listUploadJobs() });
  } catch (error) {
    next(error);
  }
});

router.get('/history', (_req, res, next) => {
  try {
    res.json(listUploadHistory());
  } catch (error) {
    next(error);
  }
});

router.get('/pending', (_req, res, next) => {
  try {
    res.json(listPendingUploads());
  } catch (error) {
    next(error);
  }
});

router.post('/pending/restore', (req, res, next) => {
  try {
    res.json(restorePendingUploads(req.body?.ids || []));
  } catch (error) {
    next(error);
  }
});

router.post('/pending', (req, res, next) => {
  try {
    res.json(saveManualPendingUploads(req.body?.items || []));
  } catch (error) {
    next(error);
  }
});

router.get('/cards', (_req, res, next) => {
  try {
    res.json(listUploadCards());
  } catch (error) {
    next(error);
  }
});

router.post('/cards/restore', (req, res, next) => {
  try {
    res.json(restoreUploadCards(req.body?.ids || []));
  } catch (error) {
    next(error);
  }
});

router.post('/cards/complete', (req, res, next) => {
  try {
    res.json(saveManualCompletedUploads(req.body?.items || []));
  } catch (error) {
    next(error);
  }
});

router.delete('/cards/:cardId', (req, res, next) => {
  try {
    res.json(deleteUploadCard(req.params.cardId));
  } catch (error) {
    next(error);
  }
});

router.post('/cards/delete-by-date', (req, res, next) => {
  try {
    res.json(deleteUploadCardsByDate(req.body?.dateKey || req.body?.date_key || ''));
  } catch (error) {
    next(error);
  }
});

router.get('/jobs/:jobId', (req, res, next) => {
  try {
    const job = loadJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: true, message: 'Upload job not found', code: 'UPLOAD_JOB_NOT_FOUND' });
    return res.json(job);
  } catch (error) {
    next(error);
  }
});

router.post('/jobs', (req, res, next) => {
  try {
    const job = createUploadJob(req.body?.items || []);
    res.json(job);
  } catch (error) {
    next(error);
  }
});

router.post('/jobs/:jobId/start', (req, res, next) => {
  try {
    const job = startUploadJob(req.params.jobId);
    res.json(job);
  } catch (error) {
    next(error);
  }
});

router.post('/jobs/:jobId/cancel', (req, res, next) => {
  try {
    const job = requestCancelUploadJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: true, message: 'Upload job not found', code: 'UPLOAD_JOB_NOT_FOUND' });
    res.json(job);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
