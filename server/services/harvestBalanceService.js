// Weight the day's harvest towards whichever channel is running out of stock.
//
// The configured locale_plan is a fixed split - 12 JP and 12 KR. It does not
// notice that uploads alternate strictly, so a day where one side produced badly
// leaves that side thin while the other keeps growing: measured 2026-08-16, the
// buffer held 9 JP against 30 KR, and the next harvest would still have taken
// 12 of each. JP would have run dry first, and the uploader's starvation
// fallback would have shipped KR twice in a row for hours.
//
// So the split is recomputed at harvest time from what is actually left. The
// lane structure inside each locale is preserved - if a locale was 6 kr_full and
// 6 highlight, a doubled allocation is 12 and 12 - because which lane an item
// belongs to is a channel-strategy decision, not a stock one.
//
// Deliberately gentle: each locale keeps at least MIN_SHARE of the day. Chasing
// the deficit exactly would drop a healthy channel to zero for a day, and a
// channel that produces nothing for a day has no Full lane material the next.
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXPORT_DIR = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts', '_automation factory');

const MIN_SHARE = 0.25;
const MAX_SHARE = 0.75;

function isKoreanLocale(locale) {
  return String(locale || '').toLowerCase().startsWith('ko');
}

// Same identity rule the uploader uses: a video is spent once it has been
// uploaded (moved to uploaded/) or held back, so only the top level counts.
function bufferCountsByChannel(exportDir = EXPORT_DIR) {
  const counts = { ko: 0, ja: 0 };
  if (!fs.existsSync(exportDir)) return counts;
  for (const name of fs.readdirSync(exportDir)) {
    if (!name.toLowerCase().endsWith('.mp4')) continue;
    if (/[가-힣]/.test(name)) counts.ko += 1;
    else counts.ja += 1;
  }
  return counts;
}

function balanceLocalePlan(localePlan = [], counts = { ko: 0, ja: 0 }) {
  const plan = Array.isArray(localePlan) ? localePlan.filter((entry) => Number(entry?.count) > 0) : [];
  if (plan.length < 2) return plan;

  const total = plan.reduce((sum, entry) => sum + Number(entry.count || 0), 0);
  if (!total) return plan;

  const koStock = Number(counts.ko) || 0;
  const jaStock = Number(counts.ja) || 0;
  const stock = koStock + jaStock;

  // With nothing on hand there is no signal to act on - keep the configured plan.
  if (!stock) return plan;

  // Deficit share: the channel holding less of the stock gets more of the day.
  let koShare = jaStock / stock;
  koShare = Math.min(MAX_SHARE, Math.max(MIN_SHARE, koShare));
  const koTotal = Math.round(total * koShare);
  const jaTotal = total - koTotal;

  const scaleGroup = (entries, groupTotal) => {
    const groupSum = entries.reduce((sum, entry) => sum + Number(entry.count || 0), 0);
    if (!groupSum) return entries.map((entry) => ({ ...entry, count: 0 }));
    const scaled = entries.map((entry) => ({
      ...entry,
      count: Math.max(1, Math.round((Number(entry.count) / groupSum) * groupTotal))
    }));
    // Rounding can drift off the group total; settle it on the largest entry.
    let drift = scaled.reduce((sum, entry) => sum + entry.count, 0) - groupTotal;
    while (drift !== 0) {
      const target = scaled
        .slice()
        .sort((a, b) => (drift > 0 ? b.count - a.count : a.count - b.count))[0];
      if (!target) break;
      if (drift > 0 && target.count <= 1) break;
      target.count += drift > 0 ? -1 : 1;
      drift += drift > 0 ? -1 : 1;
    }
    return scaled;
  };

  const koEntries = plan.filter((entry) => isKoreanLocale(entry.locale));
  const jaEntries = plan.filter((entry) => !isKoreanLocale(entry.locale));
  if (!koEntries.length || !jaEntries.length) return plan;

  const balanced = [...scaleGroup(jaEntries, jaTotal), ...scaleGroup(koEntries, koTotal)];
  return balanced.filter((entry) => entry.count > 0);
}

function describePlan(plan = []) {
  return plan
    .map((entry) => `${entry.locale}${entry.lane ? `/${entry.lane}` : ''} ${entry.count}`)
    .join(', ');
}

module.exports = {
  bufferCountsByChannel,
  balanceLocalePlan,
  describePlan,
  EXPORT_DIR,
  __test: { MIN_SHARE, MAX_SHARE, isKoreanLocale }
};
