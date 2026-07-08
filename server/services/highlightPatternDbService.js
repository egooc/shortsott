const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { PROJECT_ROOT } = require('./pipelinePaths');

const DB_PATH = path.join(PROJECT_ROOT, 'server', 'data', 'highlight_patterns.db');
const ACTIVE_STATUSES = ['queued', 'downloading', 'analyzing'];
const CHANNEL_STALE_MS = 24 * 60 * 60 * 1000;
const EXPLODED_THRESHOLD = 3;
const BURIED_THRESHOLD = 0.5;
const LABEL_MIN_AGE_DAYS = 30; // must match youtubeScoutService's CHANNEL_MEDIAN_MIN_AGE_DAYS
const PATTERN_MIN_SAMPLE_SIZE = 3;

let db = null;

function tableColumns(database, tableName) {
  return database.prepare(`PRAGMA table_info(${tableName})`).all().map((col) => col.name);
}

function ensureDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // v2 -> v3 migration: analyses moves from generic hook fields to 3-second-loop
  // fields. No real training data existed at the time of this migration (checked
  // manually), but guard on column presence rather than an unconditional DROP so a
  // future re-run never silently wipes real rows.
  const existingAnalysesColumns = tableColumns(db, 'analyses');
  if (existingAnalysesColumns.length && !existingAnalysesColumns.includes('action_phase')) {
    db.exec('DROP TABLE IF EXISTS analyses;');
  }
  const existingScoresColumns = tableColumns(db, 'scores');
  if (existingScoresColumns.length) {
    // hook_density was computed from v2 segments on the training clip itself;
    // segments are now exclusively used for slice_source timelines, and
    // patternStats()/loop_seam_similarity replace what this table gestured at.
    db.exec('DROP TABLE IF EXISTS scores;');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      title TEXT,
      subscriber_count INTEGER,
      median_views_recent30 REAL,
      median_sample_size INTEGER,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      youtube_url TEXT NOT NULL,
      channel_id TEXT REFERENCES channels(id),
      title TEXT,
      views INTEGER,
      likes INTEGER,
      comments_count INTEGER,
      duration_seconds REAL,
      upload_date TEXT,
      form_type TEXT,
      success_multiple REAL,
      views_per_day REAL,
      is_dead INTEGER,
      pipeline_status TEXT NOT NULL DEFAULT 'queued',
      error_code TEXT,
      error_message TEXT,
      video_path TEXT,
      collected_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS view_snapshots (
      id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      views INTEGER,
      captured_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_view_snapshots_video_id ON view_snapshots(video_id);

    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      model_version TEXT,
      prompt_version TEXT,
      action_described TEXT,
      material TEXT,
      tool_or_machine TEXT,
      action_phase TEXT,
      peak_moment_time REAL,
      moment_type TEXT,
      first_frame_description TEXT,
      last_frame_description TEXT,
      loop_seam TEXT,
      loop_seam_similarity REAL,
      readable_in_half_second INTEGER,
      camera TEXT,
      subject_scale TEXT,
      motion_direction TEXT,
      human_visible TEXT,
      has_text_overlay INTEGER,
      speed_appearance TEXT,
      raw_json TEXT,
      analyzed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS segments (
      id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      start_time REAL,
      end_time REAL,
      event_type TEXT,
      description TEXT
    );

    -- Track B duration A/B (PLAYBOOK.md section 3): each row is one produced
    -- edit; two rows sharing a pair_id form a matched pair from the same
    -- source_video_id (one SHORT/T = 3-5s window, one LONG/C = 6-10s window).
    -- Pairing (not odd/even publish slots) is the randomization unit because
    -- this app has no publish-slot queue -- see PLAYBOOK.md section 3 note.
    CREATE TABLE IF NOT EXISTS ab_assignments (
      id TEXT PRIMARY KEY,
      pair_id TEXT NOT NULL,
      group_label TEXT NOT NULL,
      target_duration_group TEXT NOT NULL,
      source_video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      start_sec REAL,
      end_sec REAL,
      seam_similarity INTEGER,
      slot_order TEXT,
      status TEXT NOT NULL DEFAULT 'assigned',
      dropped_reason TEXT,
      job_id TEXT,
      youtube_video_id TEXT,
      view_count_at_7d INTEGER,
      channel_median_at_7d REAL,
      success_multiple_at_7d REAL,
      avg_view_duration_pct REAL,
      scheduled_publish_at TEXT,
      publish_drift_sec REAL,
      assigned_at TEXT NOT NULL,
      produced_at TEXT,
      published_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_videos_pipeline_status ON videos(pipeline_status);
    CREATE INDEX IF NOT EXISTS idx_videos_collected_at ON videos(collected_at);
    CREATE INDEX IF NOT EXISTS idx_analyses_video_id ON analyses(video_id);
    CREATE INDEX IF NOT EXISTS idx_segments_video_id ON segments(video_id);
    CREATE INDEX IF NOT EXISTS idx_ab_assignments_pair_id ON ab_assignments(pair_id);
    CREATE INDEX IF NOT EXISTS idx_ab_assignments_status ON ab_assignments(status);

    -- Pair-integrity backstop (PLAYBOOK.md section 3): abExperimentService's
    -- createPair() already enforces this in JS, but this trigger catches any
    -- insert that bypasses the service layer entirely -- manual SQL, a future
    -- migration script, or another service inserting directly -- so the two
    -- rows sharing a pair_id can never disagree on source_video_id or end up
    -- with two SHORTs/two LONGs instead of one of each.
    CREATE TRIGGER IF NOT EXISTS trg_ab_assignments_pair_integrity
    AFTER INSERT ON ab_assignments
    BEGIN
      SELECT RAISE(ABORT, 'AB_PAIR_SOURCE_VIDEO_MISMATCH')
      WHERE (
        SELECT COUNT(DISTINCT source_video_id) FROM ab_assignments WHERE pair_id = NEW.pair_id
      ) > 1;
      SELECT RAISE(ABORT, 'AB_PAIR_DUPLICATE_DURATION_GROUP')
      WHERE (
        SELECT COUNT(*) FROM ab_assignments
        WHERE pair_id = NEW.pair_id AND target_duration_group = NEW.target_duration_group
      ) > 1;
    END;
  `);

  const videoColumns = tableColumns(db, 'videos');
  if (!videoColumns.includes('analysis_mode')) {
    db.exec(`ALTER TABLE videos ADD COLUMN analysis_mode TEXT NOT NULL DEFAULT 'training'`);
  }
  if (!videoColumns.includes('avg_view_duration_pct')) {
    db.exec(`ALTER TABLE videos ADD COLUMN avg_view_duration_pct REAL`);
  }

  // Same gotcha as above: CREATE TABLE IF NOT EXISTS is a no-op against an
  // already-existing table, so a column added to the CREATE statement here
  // never actually lands on a live DB from before this line was written.
  const channelColumns = tableColumns(db, 'channels');
  if (!channelColumns.includes('median_sample_size')) {
    db.exec(`ALTER TABLE channels ADD COLUMN median_sample_size INTEGER`);
  }
  if (!channelColumns.includes('is_excluded')) {
    db.exec(`ALTER TABLE channels ADD COLUMN is_excluded INTEGER NOT NULL DEFAULT 0`);
  }

  // v2.1: loop_seam moves from a Gemini judgment to a JS-derived value
  // (SSIM + action_is_repetitive). The old loop_seam column is left in place,
  // untouched, as the historical record of what v2.0 analyses actually judged.
  const analysesColumnsV21 = tableColumns(db, 'analyses');
  if (!analysesColumnsV21.includes('action_is_repetitive')) {
    db.exec(`ALTER TABLE analyses ADD COLUMN action_is_repetitive INTEGER`);
  }
  if (!analysesColumnsV21.includes('loop_seam_derived')) {
    db.exec(`ALTER TABLE analyses ADD COLUMN loop_seam_derived TEXT`);
  }
  if (!analysesColumnsV21.includes('unstable')) {
    db.exec(`ALTER TABLE analyses ADD COLUMN unstable INTEGER NOT NULL DEFAULT 0`);
  }

  // Gate v2 (50-video pilot): dropped action_is_repetitive from the stability
  // check (it double-counted the same root-cause error as action_phase) and
  // compares moment_type via a coarse DESTRUCTION/JOINING/TRANSFORM/UNKNOWN
  // bucket instead of exact match. Pilot rate was 30.0% (20-30% bucket) --
  // per the pre-agreed decision rule that means: proceed, but arbitrate
  // run1/run2 disagreements with a 3rd call and take the majority. This column
  // records how each row's canonical values were settled.
  if (!analysesColumnsV21.includes('stability_source')) {
    db.exec(`ALTER TABLE analyses ADD COLUMN stability_source TEXT NOT NULL DEFAULT 'clean'`);
  }

  // Switched from Vertex's YouTube-URL video understanding (fileData/fileUri)
  // to uploading the local downloaded file (inlineData) after a sustained
  // 429 tied specifically to the URL-based path. Rows before this switch are
  // backfilled 'url'; this lets input_method be compared against unstable
  // rate before treating both groups as one dataset.
  if (!analysesColumnsV21.includes('input_method')) {
    db.exec(`ALTER TABLE analyses ADD COLUMN input_method TEXT NOT NULL DEFAULT 'url'`);
  }

  // Track B duration A/B, publish-slot scheduling (PLAYBOOK.md section 3 item
  // 2/3): scheduled_publish_at is the planned adjacent 2-hour slot assigned at
  // createPair() time; publish_drift_sec is filled in at markPublished() time
  // by comparing the real publishedAt against that plan, so a pair whose
  // actual upload times drifted apart (breaking the within-pair time-of-day
  // cancellation) is visible in the report instead of silently trusted.
  const abColumns = tableColumns(db, 'ab_assignments');
  if (abColumns.length && !abColumns.includes('scheduled_publish_at')) {
    db.exec(`ALTER TABLE ab_assignments ADD COLUMN scheduled_publish_at TEXT`);
  }
  if (abColumns.length && !abColumns.includes('publish_drift_sec')) {
    db.exec(`ALTER TABLE ab_assignments ADD COLUMN publish_drift_sec REAL`);
  }

  return db;
}

function daysSince(dateStr) {
  const ms = dateStr ? new Date(dateStr).getTime() : NaN;
  return Number.isFinite(ms) ? (Date.now() - ms) / 86400000 : null;
}

// One-shot approximation from view-count data alone: real creator intent (ads,
// announcements, etc.) isn't reflected. Videos younger than LABEL_MIN_AGE_DAYS are
// PENDING regardless of success_multiple -- a brand-new upload and a brand-new
// flop look identical in the first couple weeks. MID/PENDING are excluded from
// patternStats() so only the genuine EXPLODED/BURIED contrast set feeds stats.
function labelFor(successMultiple, uploadDate) {
  const age = daysSince(uploadDate);
  if (age !== null && age < LABEL_MIN_AGE_DAYS) return 'PENDING';
  if (!Number.isFinite(successMultiple)) return null;
  if (successMultiple >= EXPLODED_THRESHOLD) return 'EXPLODED';
  if (successMultiple <= BURIED_THRESHOLD) return 'BURIED';
  return 'MID';
}

function getChannel(id) {
  const database = ensureDb();
  return database.prepare(`SELECT * FROM channels WHERE id = ?`).get(id) || null;
}

function setChannelExcluded(channelId, excluded) {
  const database = ensureDb();
  database.prepare(`UPDATE channels SET is_excluded = ? WHERE id = ?`).run(excluded ? 1 : 0, channelId);
}

function findChannelByTitle(title) {
  const database = ensureDb();
  return database.prepare(`SELECT * FROM channels WHERE title = ?`).get(title) || null;
}

function isChannelStale(channel, now) {
  if (!channel) return true;
  const updatedAtMs = new Date(channel.updated_at).getTime();
  if (!Number.isFinite(updatedAtMs)) return true;
  return new Date(now).getTime() - updatedAtMs > CHANNEL_STALE_MS;
}

function upsertChannel({ id, title, subscriberCount, medianViewsRecent30, medianSampleSize, now }) {
  const database = ensureDb();
  database.prepare(`
    INSERT INTO channels (id, title, subscriber_count, median_views_recent30, median_sample_size, updated_at)
    VALUES (@id, @title, @subscriberCount, @medianViewsRecent30, @medianSampleSize, @now)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      subscriber_count = excluded.subscriber_count,
      median_views_recent30 = excluded.median_views_recent30,
      median_sample_size = excluded.median_sample_size,
      updated_at = excluded.updated_at
  `).run({
    id,
    title: title || '',
    subscriberCount: subscriberCount ?? null,
    medianViewsRecent30: medianViewsRecent30 ?? null,
    medianSampleSize: medianSampleSize ?? null,
    now
  });
}

function insertViewSnapshot(videoId, views, now) {
  const database = ensureDb();
  database.prepare(`
    INSERT INTO view_snapshots (id, video_id, views, captured_at)
    VALUES (@id, @videoId, @views, @now)
  `).run({ id: `${videoId}_${now}`, videoId, views: views ?? null, now });
}

function getViewSnapshots(videoId) {
  const database = ensureDb();
  return database.prepare(`SELECT * FROM view_snapshots WHERE video_id = ? ORDER BY captured_at ASC`).all(videoId);
}

function upsertVideo(video) {
  const database = ensureDb();
  database.prepare(`
    INSERT INTO videos (
      id, youtube_url, channel_id, title, views, likes, comments_count, duration_seconds,
      upload_date, form_type, success_multiple, views_per_day, is_dead, analysis_mode,
      pipeline_status, collected_at, updated_at
    ) VALUES (
      @id, @youtubeUrl, @channelId, @title, @views, @likes, @commentsCount, @durationSeconds,
      @uploadDate, @formType, @successMultiple, @viewsPerDay, @isDead, @analysisMode,
      'queued', @now, @now
    )
    ON CONFLICT(id) DO UPDATE SET
      youtube_url = excluded.youtube_url,
      channel_id = excluded.channel_id,
      title = excluded.title,
      views = excluded.views,
      likes = excluded.likes,
      comments_count = excluded.comments_count,
      duration_seconds = excluded.duration_seconds,
      upload_date = excluded.upload_date,
      form_type = excluded.form_type,
      success_multiple = excluded.success_multiple,
      views_per_day = excluded.views_per_day,
      is_dead = excluded.is_dead,
      analysis_mode = excluded.analysis_mode,
      pipeline_status = 'queued',
      error_code = NULL,
      error_message = NULL,
      updated_at = excluded.updated_at
  `).run({
    id: video.id,
    youtubeUrl: video.youtubeUrl,
    channelId: video.channelId || null,
    title: video.title || '',
    views: video.views ?? null,
    likes: video.likes ?? null,
    commentsCount: video.commentsCount ?? null,
    durationSeconds: video.durationSeconds ?? null,
    uploadDate: video.uploadDate || null,
    formType: video.formType || null,
    successMultiple: video.successMultiple ?? null,
    viewsPerDay: video.viewsPerDay ?? null,
    isDead: video.isDead === null || video.isDead === undefined ? null : (video.isDead ? 1 : 0),
    analysisMode: video.analysisMode || 'training',
    now: video.now
  });
  return getVideoRow(video.id);
}

function getVideoRow(id) {
  const database = ensureDb();
  return database.prepare(`SELECT * FROM videos WHERE id = ?`).get(id) || null;
}

function updateVideoStatus(id, status, now) {
  const database = ensureDb();
  database.prepare(`UPDATE videos SET pipeline_status = @status, updated_at = @now WHERE id = @id`)
    .run({ id, status, now });
}

function updateVideoPath(id, videoPath, now) {
  const database = ensureDb();
  database.prepare(`UPDATE videos SET video_path = @videoPath, updated_at = @now WHERE id = @id`)
    .run({ id, videoPath, now });
}

function updateVideoSuccess(id, now) {
  const database = ensureDb();
  database.prepare(`
    UPDATE videos SET pipeline_status = 'success', error_code = NULL, error_message = NULL, updated_at = @now
    WHERE id = @id
  `).run({ id, now });
}

function updateVideoFailure(id, { code, message, now }) {
  const database = ensureDb();
  database.prepare(`
    UPDATE videos SET pipeline_status = 'failed', error_code = @code, error_message = @message, updated_at = @now
    WHERE id = @id
  `).run({ id, code: code || 'UNKNOWN', message: message || '', now });
}

function failStaleActiveRows(now, reasonCode = 'server_restarted') {
  const database = ensureDb();
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
  const info = database.prepare(`
    UPDATE videos
    SET pipeline_status = 'failed', error_code = ?, error_message = ?, updated_at = ?
    WHERE pipeline_status IN (${placeholders})
  `).run(reasonCode, 'Server restarted while this item was still processing. Re-submit the URL.', now, ...ACTIVE_STATUSES);
  return info.changes;
}

function insertAnalysis(analysisRow) {
  const database = ensureDb();
  database.prepare(`
    INSERT INTO analyses (
      id, video_id, model_version, prompt_version, action_described, material, tool_or_machine,
      action_phase, peak_moment_time, moment_type, first_frame_description, last_frame_description,
      loop_seam, loop_seam_similarity, action_is_repetitive, loop_seam_derived, unstable, stability_source, input_method,
      readable_in_half_second, camera, subject_scale,
      motion_direction, human_visible, has_text_overlay, speed_appearance, raw_json, analyzed_at
    ) VALUES (
      @id, @videoId, @modelVersion, @promptVersion, @actionDescribed, @material, @toolOrMachine,
      @actionPhase, @peakMomentTime, @momentType, @firstFrameDescription, @lastFrameDescription,
      @loopSeam, @loopSeamSimilarity, @actionIsRepetitive, @loopSeamDerived, @unstable, @stabilitySource, @inputMethod,
      @readableInHalfSecond, @camera, @subjectScale,
      @motionDirection, @humanVisible, @hasTextOverlay, @speedAppearance, @rawJson, @now
    )
  `).run({
    id: analysisRow.id,
    videoId: analysisRow.videoId,
    modelVersion: analysisRow.modelVersion || '',
    promptVersion: analysisRow.promptVersion || '',
    actionDescribed: analysisRow.actionDescribed || '',
    material: analysisRow.material || '',
    toolOrMachine: analysisRow.toolOrMachine || '',
    actionPhase: analysisRow.actionPhase || 'UNKNOWN',
    peakMomentTime: analysisRow.peakMomentTime ?? null,
    momentType: analysisRow.momentType || 'UNKNOWN',
    firstFrameDescription: analysisRow.firstFrameDescription || '',
    lastFrameDescription: analysisRow.lastFrameDescription || '',
    // Legacy Gemini-judged loop_seam: only populated for v2.0-era inserts (kept
    // as historical record). v2.1+ leaves this null and uses loop_seam_derived.
    loopSeam: analysisRow.loopSeam ?? null,
    loopSeamSimilarity: analysisRow.loopSeamSimilarity ?? null,
    actionIsRepetitive: analysisRow.actionIsRepetitive === null || analysisRow.actionIsRepetitive === undefined
      ? null
      : (analysisRow.actionIsRepetitive ? 1 : 0),
    loopSeamDerived: analysisRow.loopSeamDerived ?? null,
    unstable: analysisRow.unstable ? 1 : 0,
    stabilitySource: analysisRow.stabilitySource || 'clean',
    inputMethod: analysisRow.inputMethod || 'url',
    readableInHalfSecond: analysisRow.readableInHalfSecond ? 1 : 0,
    camera: analysisRow.camera || '',
    subjectScale: analysisRow.subjectScale || '',
    motionDirection: analysisRow.motionDirection || '',
    humanVisible: analysisRow.humanVisible || '',
    hasTextOverlay: analysisRow.hasTextOverlay ? 1 : 0,
    speedAppearance: analysisRow.speedAppearance || '',
    rawJson: JSON.stringify(analysisRow.raw || {}),
    now: analysisRow.now
  });
}

function replaceSegments(videoId, segments = []) {
  const database = ensureDb();
  const tx = database.transaction(() => {
    database.prepare(`DELETE FROM segments WHERE video_id = ?`).run(videoId);
    const insert = database.prepare(`
      INSERT INTO segments (id, video_id, start_time, end_time, event_type, description)
      VALUES (@id, @videoId, @startTime, @endTime, @eventType, @description)
    `);
    segments.forEach((segment, index) => {
      insert.run({
        id: `${videoId}_seg_${index}`,
        videoId,
        startTime: Number.isFinite(segment.start_time) ? segment.start_time : null,
        endTime: Number.isFinite(segment.end_time) ? segment.end_time : null,
        eventType: segment.event_type || 'UNKNOWN',
        description: segment.description || ''
      });
    });
  });
  tx();
}

function getSegments(videoId) {
  const database = ensureDb();
  return database.prepare(`SELECT * FROM segments WHERE video_id = ? ORDER BY start_time ASC`).all(videoId);
}

const JOINED_SELECT = `
  SELECT
    v.*,
    c.title AS channel_title,
    c.subscriber_count AS channel_subscriber_count,
    c.median_views_recent30 AS channel_median_views_recent30,
    a.id AS analysis_id, a.model_version, a.prompt_version, a.action_described, a.material, a.tool_or_machine,
    a.action_phase, a.peak_moment_time, a.moment_type, a.first_frame_description, a.last_frame_description,
    a.loop_seam, a.loop_seam_similarity, a.action_is_repetitive, a.loop_seam_derived, a.unstable, a.stability_source, a.input_method,
    a.readable_in_half_second, a.camera, a.subject_scale,
    a.motion_direction, a.human_visible, a.has_text_overlay, a.speed_appearance, a.raw_json, a.analyzed_at
  FROM videos v
  LEFT JOIN channels c ON c.id = v.channel_id
  LEFT JOIN analyses a ON a.id = (
    SELECT id FROM analyses a2 WHERE a2.video_id = v.id ORDER BY a2.analyzed_at DESC LIMIT 1
  )
`;

// PERFECT_FIT and ALIGNMENT are conceptually adjacent enough that Gemini flips
// between them often (confirmed in calibration) -- merge for pattern-stats
// aggregation so that noise doesn't split one real pattern into two rows.
function momentTypeForStats(momentType) {
  return momentType === 'PERFECT_FIT' || momentType === 'ALIGNMENT' ? 'FIT_ALIGN' : momentType;
}

// Stability gate v2 (50-video pilot): comparing moment_type exactly made
// several genuinely-adjacent pairs (EJECTION/TRANSFORMATION, CUT_THROUGH/
// SEPARATION, in addition to the already-known PERFECT_FIT/ALIGNMENT) count
// as instability. Coarser buckets separate real disagreement (e.g. DESTRUCTION
// vs JOINING) from within-bucket noise, without changing patternStats'
// reporting granularity (that still uses momentTypeForStats above).
const MOMENT_TYPE_COARSE = {
  CUT_THROUGH: 'DESTRUCTION', CRUSH: 'DESTRUCTION', SEPARATION: 'DESTRUCTION',
  PERFECT_FIT: 'JOINING', ALIGNMENT: 'JOINING',
  TRANSFORMATION: 'TRANSFORM', EJECTION: 'TRANSFORM',
  UNKNOWN: 'UNKNOWN'
};
function momentTypeCoarse(momentType) {
  return MOMENT_TYPE_COARSE[momentType] || 'UNKNOWN';
}

// FULL_ARC <-> MID_PROCESS has been the single dominant action_phase
// confusion at every measurement scale in this project (5/8 v2.0 calibration
// failures, 10/50 pilot, 8/8 of the Pro-vs-Flash action_phase disagreements)
// -- always this exact pair, never a genuinely different category. Merged
// for both the stability gate and patternStats' grouping axis; the other
// four values (IMPACT_CENTERED, PRE_IMPACT_CUT, RESULT_ONLY, UNKNOWN) stay
// distinct since they've never shown this same recurring confusion.
const ACTION_PHASE_COARSE_SQL_CASE = `
  CASE WHEN a.action_phase IN ('FULL_ARC', 'MID_PROCESS') THEN 'PROCESS' ELSE a.action_phase END
`;
function actionPhaseCoarse(actionPhase) {
  return (actionPhase === 'FULL_ARC' || actionPhase === 'MID_PROCESS') ? 'PROCESS' : actionPhase;
}

// loop_seam_derived demoted from a patternStats grouping axis to a reference-
// only column (mid-batch check on ~150 real analyses): SSIM never crosses the
// 0.85 SEAMLESS threshold for this genre, so derived collapses to a bare
// function of action_is_repetitive -- which the stability gate no longer even
// checks (dropped in gate v2 for double-counting with action_phase). Result:
// action_is_repetitive disagreed between run1/run2 on 9.8% of videos, and
// 100% of those flipped loop_seam_derived, with several sneaking through as
// "stable" since nothing gates on that field anymore. Raw SSIM is
// deterministic (zero Gemini variance) and gets used directly instead, in
// quartile buckets computed from the same ~150-analysis sample (Q1=9, Q2=14,
// Q3=20) -- provisional pending the full 563-video distribution.
const SSIM_QUARTILE_BOUNDS = { q1: 9, q2: 14, q3: 20 };
function ssimQuartileBucket(similarity) {
  if (similarity === null || similarity === undefined) return 'UNKNOWN';
  if (similarity <= SSIM_QUARTILE_BOUNDS.q1) return 'Q1_LOWEST';
  if (similarity <= SSIM_QUARTILE_BOUNDS.q2) return 'Q2';
  if (similarity <= SSIM_QUARTILE_BOUNDS.q3) return 'Q3';
  return 'Q4_HIGHEST';
}
const SSIM_QUARTILE_SQL_CASE = `
  CASE
    WHEN a.loop_seam_similarity IS NULL THEN 'UNKNOWN'
    WHEN a.loop_seam_similarity <= ${SSIM_QUARTILE_BOUNDS.q1} THEN 'Q1_LOWEST'
    WHEN a.loop_seam_similarity <= ${SSIM_QUARTILE_BOUNDS.q2} THEN 'Q2'
    WHEN a.loop_seam_similarity <= ${SSIM_QUARTILE_BOUNDS.q3} THEN 'Q3'
    ELSE 'Q4_HIGHEST'
  END
`;

function rowToRecord(row) {
  if (!row) return null;
  return {
    ...row,
    is_dead: row.is_dead === null || row.is_dead === undefined ? null : Boolean(row.is_dead),
    action_is_repetitive: row.action_is_repetitive === null || row.action_is_repetitive === undefined
      ? null
      : Boolean(row.action_is_repetitive),
    unstable: Boolean(row.unstable),
    readable_in_half_second: row.readable_in_half_second === null || row.readable_in_half_second === undefined
      ? null
      : Boolean(row.readable_in_half_second),
    has_text_overlay: row.has_text_overlay === null || row.has_text_overlay === undefined ? null : Boolean(row.has_text_overlay),
    raw_json: row.raw_json ? JSON.parse(row.raw_json) : null,
    label: labelFor(row.success_multiple, row.upload_date)
  };
}

// Restricted to the genuine EXPLODED/BURIED contrast set (mirrors labelFor's
// thresholds + maturity gate, expressed in SQL since analyses.video_id join needs
// it server-side) -- MID/PENDING videos would dilute the exploded_rate signal.
// Groups by coarse action_phase (FULL_ARC/MID_PROCESS merged into PROCESS --
// see actionPhaseCoarse's comment; the raw column is preserved untouched),
// raw SSIM quartile (not loop_seam_derived -- see ssimQuartileBucket's
// comment), and the PERFECT_FIT/ALIGNMENT-merged moment_type. Excludes rows
// flagged unstable. loop_seam_derived is still surfaced per-group as a
// reference distribution (not a grouping key) since it's no longer trustworthy
// enough to split rows by.
function patternStats({ minSampleSize = PATTERN_MIN_SAMPLE_SIZE } = {}) {
  const database = ensureDb();
  return database.prepare(`
    SELECT ${ACTION_PHASE_COARSE_SQL_CASE} AS action_phase,
           ${SSIM_QUARTILE_SQL_CASE} AS seam_bucket,
           CASE WHEN a.moment_type IN ('PERFECT_FIT', 'ALIGNMENT') THEN 'FIT_ALIGN' ELSE a.moment_type END AS moment_type,
           COUNT(*) AS n,
           AVG(v.success_multiple) AS avg_success_multiple,
           AVG(a.loop_seam_similarity) AS avg_seam_similarity,
           CAST(SUM(CASE WHEN a.loop_seam_derived = 'NATURAL_RESET' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS natural_reset_share,
           CAST(SUM(CASE WHEN v.success_multiple >= ${EXPLODED_THRESHOLD} THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS exploded_rate
    FROM videos v
    JOIN analyses a ON a.id = (
      SELECT id FROM analyses a2 WHERE a2.video_id = v.id ORDER BY a2.analyzed_at DESC LIMIT 1
    )
    LEFT JOIN channels c ON c.id = v.channel_id
    WHERE v.analysis_mode = 'training'
      AND v.success_multiple IS NOT NULL
      AND (v.success_multiple >= ${EXPLODED_THRESHOLD} OR v.success_multiple <= ${BURIED_THRESHOLD})
      AND (julianday('now') - julianday(v.upload_date)) >= ${LABEL_MIN_AGE_DAYS}
      AND (c.is_excluded IS NULL OR c.is_excluded = 0)
      AND a.unstable = 0
    GROUP BY ${ACTION_PHASE_COARSE_SQL_CASE}, ${SSIM_QUARTILE_SQL_CASE},
             CASE WHEN a.moment_type IN ('PERFECT_FIT', 'ALIGNMENT') THEN 'FIT_ALIGN' ELSE a.moment_type END
    HAVING COUNT(*) >= @minSampleSize
    ORDER BY exploded_rate DESC, n DESC
  `).all({ minSampleSize });
}

// The set of videos a future batch-analysis trigger would pull from -- excludes
// videos from is_excluded channels even though their rows/history stay in the DB.
function listAnalysisCandidates({ labels = ['EXPLODED', 'BURIED'] } = {}) {
  const database = ensureDb();
  const rows = database.prepare(`
    SELECT v.*
    FROM videos v
    LEFT JOIN channels c ON c.id = v.channel_id
    WHERE v.analysis_mode = 'training'
      AND (c.is_excluded IS NULL OR c.is_excluded = 0)
  `).all();
  return rows.map(rowToRecord).filter((v) => labels.includes(v.label));
}

function listAll() {
  const database = ensureDb();
  const rows = database.prepare(`${JOINED_SELECT} ORDER BY v.collected_at DESC`).all();
  const allSegments = database.prepare(`SELECT * FROM segments ORDER BY start_time ASC`).all();
  const segmentsByVideoId = new Map();
  allSegments.forEach((segment) => {
    if (!segmentsByVideoId.has(segment.video_id)) segmentsByVideoId.set(segment.video_id, []);
    segmentsByVideoId.get(segment.video_id).push(segment);
  });

  const items = rows.map((row) => {
    const record = rowToRecord(row);
    record.segments = segmentsByVideoId.get(row.id) || [];
    return record;
  });

  return { items, summary: patternStats() };
}

function getById(id) {
  const database = ensureDb();
  const row = database.prepare(`${JOINED_SELECT} WHERE v.id = ?`).get(id);
  const record = rowToRecord(row);
  if (!record) return null;
  record.segments = getSegments(id);
  return record;
}

function listAllVideoIds() {
  const database = ensureDb();
  return database.prepare(`SELECT id FROM videos`).all().map((row) => row.id);
}

function remove(id) {
  const database = ensureDb();
  database.prepare(`DELETE FROM videos WHERE id = ?`).run(id);
}

// --- Track B duration A/B ledger (ab_assignments) ---
// One row per produced edit; pair_id groups the SHORT(T)/LONG(C) pair cut
// from the same source_video_id. See PLAYBOOK.md section 3.

function insertAbAssignment(row) {
  const database = ensureDb();
  database.prepare(`
    INSERT INTO ab_assignments (
      id, pair_id, group_label, target_duration_group, source_video_id,
      start_sec, end_sec, seam_similarity, slot_order, scheduled_publish_at,
      status, assigned_at, updated_at
    ) VALUES (
      @id, @pairId, @groupLabel, @targetDurationGroup, @sourceVideoId,
      @startSec, @endSec, @seamSimilarity, @slotOrder, @scheduledPublishAt,
      'assigned', @now, @now
    )
  `).run({
    id: row.id,
    pairId: row.pairId,
    groupLabel: row.groupLabel,
    targetDurationGroup: row.targetDurationGroup,
    sourceVideoId: row.sourceVideoId,
    startSec: row.startSec ?? null,
    endSec: row.endSec ?? null,
    seamSimilarity: row.seamSimilarity ?? null,
    slotOrder: row.slotOrder,
    scheduledPublishAt: row.scheduledPublishAt ?? null,
    now: row.now
  });
}

// Slot allocation cursor for the next pair (PLAYBOOK.md section 3 item 2):
// the last planned slot across all pairs so far, so a new pair's two adjacent
// 2-hour slots always continue after every previously scheduled slot instead
// of overlapping one still pending production/publish.
function getLatestScheduledPublishAt() {
  const database = ensureDb();
  const row = database.prepare(`SELECT MAX(scheduled_publish_at) AS latest FROM ab_assignments`).get();
  return row?.latest || null;
}

function getAbAssignment(id) {
  const database = ensureDb();
  return database.prepare(`SELECT * FROM ab_assignments WHERE id = ?`).get(id) || null;
}

function getAbPair(pairId) {
  const database = ensureDb();
  return database.prepare(`SELECT * FROM ab_assignments WHERE pair_id = ? ORDER BY group_label ASC`).all(pairId);
}

function listAbAssignments() {
  const database = ensureDb();
  return database.prepare(`SELECT * FROM ab_assignments ORDER BY assigned_at DESC`).all();
}

function updateAbAssignmentStatus(id, { status, droppedReason, jobId, youtubeVideoId, producedAt, publishedAt, now }) {
  const database = ensureDb();
  const current = database.prepare(`SELECT * FROM ab_assignments WHERE id = ?`).get(id);
  if (!current) return null;

  // PLAYBOOK.md section 3 item 3: "발행 시점에 실제 publishAt 검증" -- compare the
  // real publish time against the slot planned at createPair() time so a pair
  // whose actual uploads drifted apart (breaking the within-pair time-of-day
  // cancellation the design relies on) shows up in the report instead of
  // being silently trusted.
  const effectivePublishedAt = publishedAt ?? current.published_at;
  let publishDriftSec = current.publish_drift_sec ?? null;
  if (status === 'published' && effectivePublishedAt && current.scheduled_publish_at) {
    publishDriftSec = (new Date(effectivePublishedAt).getTime() - new Date(current.scheduled_publish_at).getTime()) / 1000;
  }

  database.prepare(`
    UPDATE ab_assignments SET
      status = @status,
      dropped_reason = @droppedReason,
      job_id = @jobId,
      youtube_video_id = @youtubeVideoId,
      produced_at = @producedAt,
      published_at = @publishedAt,
      publish_drift_sec = @publishDriftSec,
      updated_at = @now
    WHERE id = @id
  `).run({
    id,
    status: status || current.status,
    droppedReason: droppedReason ?? current.dropped_reason,
    jobId: jobId ?? current.job_id,
    youtubeVideoId: youtubeVideoId ?? current.youtube_video_id,
    producedAt: producedAt ?? current.produced_at,
    publishedAt: publishedAt ?? current.published_at,
    publishDriftSec,
    now
  });
  return database.prepare(`SELECT * FROM ab_assignments WHERE id = ?`).get(id);
}

function recordAbMetrics(id, { viewCountAt7d, channelMedianAt7d, successMultipleAt7d, avgViewDurationPct, now }) {
  const database = ensureDb();
  database.prepare(`
    UPDATE ab_assignments SET
      view_count_at_7d = @viewCountAt7d,
      channel_median_at_7d = @channelMedianAt7d,
      success_multiple_at_7d = @successMultipleAt7d,
      avg_view_duration_pct = @avgViewDurationPct,
      updated_at = @now
    WHERE id = @id
  `).run({
    id,
    viewCountAt7d: viewCountAt7d ?? null,
    channelMedianAt7d: channelMedianAt7d ?? null,
    successMultipleAt7d: successMultipleAt7d ?? null,
    avgViewDurationPct: avgViewDurationPct ?? null,
    now
  });
}

// Pairs eligible for statistical analysis: both members published with
// recorded 7-day metrics, AND neither member dropped. A dropped member voids
// the whole pair (PLAYBOOK.md section 3, item 4 -- pair-level completeness).
function getEligibleAbPairs() {
  const database = ensureDb();
  const rows = database.prepare(`SELECT * FROM ab_assignments`).all();
  const byPair = new Map();
  rows.forEach((row) => {
    if (!byPair.has(row.pair_id)) byPair.set(row.pair_id, []);
    byPair.get(row.pair_id).push(row);
  });

  const eligible = [];
  const dropoutByGroup = { T: { total: 0, dropped: 0 }, C: { total: 0, dropped: 0 } };
  // Mann-Whitney backup sample (PLAYBOOK.md section 3 item 5): the surviving
  // member of a pair whose partner dropped can't feed the paired Wilcoxon
  // test, but it still carries duration-effect signal -- collect it here as
  // an unpaired fallback rather than discarding it outright.
  const unpairedByGroup = { T: [], C: [] };
  for (const [pairId, members] of byPair) {
    members.forEach((m) => {
      dropoutByGroup[m.group_label].total += 1;
      if (m.status === 'dropped') dropoutByGroup[m.group_label].dropped += 1;
    });
    if (members.length !== 2) continue;
    const anyDropped = members.some((m) => m.status === 'dropped');
    if (anyDropped) {
      const survivor = members.find((m) => m.status !== 'dropped');
      if (survivor && survivor.status === 'published' && survivor.success_multiple_at_7d !== null && survivor.success_multiple_at_7d !== undefined) {
        unpairedByGroup[survivor.group_label].push(survivor.success_multiple_at_7d);
      }
      continue;
    }
    const t = members.find((m) => m.group_label === 'T');
    const c = members.find((m) => m.group_label === 'C');
    if (!t || !c) continue;
    if (t.status !== 'published' || c.status !== 'published') continue;
    if (t.success_multiple_at_7d === null || c.success_multiple_at_7d === null) continue;
    eligible.push({ pairId, t, c });
  }
  return { eligible, dropoutByGroup, unpairedByGroup };
}

module.exports = {
  DB_PATH,
  getChannel,
  setChannelExcluded,
  findChannelByTitle,
  isChannelStale,
  upsertChannel,
  upsertVideo,
  getVideoRow,
  updateVideoStatus,
  updateVideoPath,
  updateVideoSuccess,
  updateVideoFailure,
  failStaleActiveRows,
  insertAnalysis,
  replaceSegments,
  getSegments,
  patternStats,
  momentTypeForStats,
  momentTypeCoarse,
  actionPhaseCoarse,
  ssimQuartileBucket,
  labelFor,
  insertViewSnapshot,
  getViewSnapshots,
  listAnalysisCandidates,
  listAll,
  listAllVideoIds,
  getById,
  remove,
  insertAbAssignment,
  getLatestScheduledPublishAt,
  getAbAssignment,
  getAbPair,
  listAbAssignments,
  updateAbAssignmentStatus,
  recordAbMetrics,
  getEligibleAbPairs
};
