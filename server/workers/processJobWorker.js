const path = require('path');
const dotenv = require('dotenv');
const { runJob, readJob } = require('../services/processJobService');

dotenv.config({ path: path.join(__dirname, '../../.env') });

async function main() {
  const jobId = process.argv[2] || process.env.PROCESS_JOB_ID || '';
  if (!jobId) {
    console.error('processJobWorker requires a job id');
    process.exitCode = 1;
    return;
  }

  try {
    const job = readJob(jobId);
    if (job.cancel_requested) {
      console.log(`job ${jobId} is already cancel requested`);
      return;
    }
    await runJob(jobId);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

main();
