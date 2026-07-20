#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const repoRoot = path.resolve(__dirname, '../..');
dotenv.config({ path: path.join(repoRoot, '.env') });

const { analyzeMidformVideo } = require('../../server/services/geminiMidformService');

async function main() {
  const schemaFile = process.argv[2];
  const label = process.argv[3] || path.basename(schemaFile || 'probe', '.json');
  if (!schemaFile) {
    console.error('Usage: node midform/scripts/run_schema_probe.js <schema_file> <label>');
    process.exit(2);
  }

  const probeDir = path.join(repoRoot, 'midform/test_runs/schema_probe');
  fs.mkdirSync(probeDir, { recursive: true });
  const sourcePath = path.join(repoRoot, 'midform/test_runs/run_001_3uwrL9unVek/source.mp4');
  const endpoint = 'https://aiplatform.googleapis.com/v1/projects/project-b341a363-4d35-4813-a99/locations/global/publishers/google/models/gemini-2.5-flash:generateContent';

  process.env.GEMINI_MIDFORM_SCHEMA_FILE = schemaFile;
  process.env.GEMINI_VERTEX_ENDPOINT_OVERRIDE = endpoint;

  const startedAt = new Date();
  const result = {
    label,
    schema_file: schemaFile,
    endpoint,
    source_path: sourcePath,
    started_at: startedAt.toISOString(),
    completed_at: null,
    elapsed_sec: null,
    vertex_status: null,
    probe_status: 'unknown',
    response: null,
    error: null
  };

  try {
    const analysis = await analyzeMidformVideo(sourcePath, 'movie_midform_recap', { validateTopLevel: false });
    result.vertex_status = 200;
    result.probe_status = 'passed';
    result.response = analysis;
  } catch (error) {
    const status = error?.details?.status || error?.status || null;
    result.vertex_status = status;
    result.probe_status = status === 400 ? 'failed_schema_or_request' : 'failed_other';
    result.error = {
      message: error?.message || String(error),
      code: error?.code || null,
      status,
      details: error?.details || null
    };
  } finally {
    const completedAt = new Date();
    result.completed_at = completedAt.toISOString();
    result.elapsed_sec = Math.round((completedAt.getTime() - startedAt.getTime()) / 1000);
    const outPath = path.join(probeDir, `probe_${label}_result.json`);
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
