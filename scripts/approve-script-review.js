require('dotenv').config();

const queueService = require('../server/services/processQueueService');

const itemId = process.argv[2];

if (!itemId) {
  console.error('Usage: node scripts/approve-script-review.js <item_id>');
  process.exit(1);
}

(async () => {
  try {
    const result = await queueService.approveKoreanFullDraftScriptReview(itemId);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      status: 'failed',
      code: error.code || error.name || '',
      message: error.message,
      details: error.details || null
    }, null, 2));
    process.exit(1);
  }
})();
