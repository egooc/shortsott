// Show the harvest channel ledger so blocked channels can be eyeballed and
// reversed (approved 2026-08-13 - blocking is a heuristic, so it must be
// auditable).
//
//   node scripts/channel-ledger-report.js            # summary
//   node scripts/channel-ledger-report.js --unblock "Some Channel"
//
// A channel is blocked after BLOCK_AFTER_SKIPS gate failures with zero
// successes; --unblock clears its counters so the harvest considers it again.

const {
  BLOCK_AFTER_SKIPS,
  loadChannelLedger,
  saveChannelLedger,
  blockedChannels,
  assetChannels,
  channelKey
} = require('../server/services/sourceChannelLedgerService');

function pad(text, width) {
  const value = String(text ?? '');
  return value.length >= width ? value.slice(0, width) : value + ' '.repeat(width - value.length);
}

function unblock(name) {
  const ledger = loadChannelLedger();
  const entry = ledger.channels[channelKey(name)];
  if (!entry) {
    console.log(`no ledger entry for "${name}"`);
    return 1;
  }
  entry.skipped = 0;
  entry.skip_reasons = [];
  saveChannelLedger(ledger);
  console.log(`unblocked "${entry.creator}" (skip counter reset)`);
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  const unblockAt = argv.indexOf('--unblock');
  if (unblockAt >= 0) {
    process.exit(unblock(argv[unblockAt + 1] || ''));
  }

  const ledger = loadChannelLedger();
  const all = Object.values(ledger.channels);
  const blocked = blockedChannels(ledger);
  const assets = assetChannels(ledger);

  console.log(`채널 원장: ${all.length}개 채널 (배제 기준: 성공 0회 + 스킵 ${BLOCK_AFTER_SKIPS}회 이상)\n`);

  console.log(`=== 배제된 채널 (${blocked.length}) ===`);
  if (!blocked.length) console.log('  (없음)');
  for (const entry of blocked) {
    console.log(`  ${pad(entry.creator, 34)} 스킵 ${entry.skipped}회  최근 ${String(entry.last_skip_at).slice(0, 10)}`);
    for (const reason of entry.skip_reasons.slice(0, 2)) console.log(`      - ${reason}`);
    if (entry.channel_url) console.log(`      ${entry.channel_url}`);
  }

  console.log(`\n=== 자산 채널 (${assets.length}) ===`);
  if (!assets.length) console.log('  (없음)');
  for (const entry of assets) {
    console.log(`  ${pad(entry.creator, 34)} 성공 ${entry.ok}회 / 스킵 ${entry.skipped}회  최근 ${String(entry.last_ok_at).slice(0, 10)}`);
    if (entry.channel_url) console.log(`      ${entry.channel_url}`);
  }

  const watching = all.filter((e) => e.ok === 0 && e.skipped > 0 && e.skipped < BLOCK_AFTER_SKIPS);
  if (watching.length) {
    console.log(`\n=== 관찰 중 (${watching.length}) — 한 번 더 걸리면 배제 ===`);
    for (const entry of watching) {
      console.log(`  ${pad(entry.creator, 34)} 스킵 ${entry.skipped}회`);
    }
  }

  console.log('\n오판이면: node scripts/channel-ledger-report.js --unblock "<채널명>"');
}

main();
