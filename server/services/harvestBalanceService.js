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
  const counts = { ko: 0, ja: 0, ko_full: 0, ja_full: 0, ko_hl: 0, ja_hl: 0 };
  if (!fs.existsSync(exportDir)) return counts;
  for (const name of fs.readdirSync(exportDir)) {
    if (!name.toLowerCase().endsWith('.mp4')) continue;
    const channel = /[가-힣]/.test(name) ? 'ko' : 'ja';
    const variant = /-F-/.test(name) ? 'full' : 'hl';
    counts[channel] += 1;
    counts[`${channel}_${variant}`] += 1;
  }
  return counts;
}

function balanceLocalePlan(localePlan = [], counts = { ko: 0, ja: 0 }) {
  const plan = Array.isArray(localePlan) ? localePlan.filter((entry) => Number(entry?.count) > 0) : [];
  if (plan.length < 2) return plan;

  const total = plan.reduce((sum, entry) => sum + Number(entry.count || 0), 0);
  if (!total) return plan;

  // Balance each variant against its own stock, not against the channel total.
  //
  // Counting whole channels let highlights mask a Full shortage: a longform
  // source yields several highlights but only one Full, so the KR buffer looked
  // healthy at 30 videos while its Full lane was starving. Measured 2026-08-18 -
  // ja_full had been assigned 52 sources against kr_full's 28, and the KR channel
  // had shipped 11 Fulls to the JP channel's 21, even though kr_full converts
  // sources into Fulls at a better rate (50% vs 31%). Full is the audio-language
  // signal for its channel, so it cannot be left to drift.
  const isFullLane = (entry) => String(entry.lane || '').endsWith('_full');
  const splitByStock = (entries, groupTotal, koStock, jaStock) => {
    const koEntries = entries.filter((entry) => isKoreanLocale(entry.locale));
    const jaEntries = entries.filter((entry) => !isKoreanLocale(entry.locale));
    if (!koEntries.length || !jaEntries.length) return { koEntries, jaEntries, koTotal: 0, jaTotal: 0 };
    const stock = koStock + jaStock;
    // Nothing on hand is no signal - split it evenly.
    let koShare = stock ? jaStock / stock : 0.5;
    koShare = Math.min(MAX_SHARE, Math.max(MIN_SHARE, koShare));
    const koTotal = Math.round(groupTotal * koShare);
    return { koEntries, jaEntries, koTotal, jaTotal: groupTotal - koTotal };
  };

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

  // Full lanes are balanced against Full stock, highlight entries against
  // highlight stock, and each variant keeps the share of the day it was
  // configured with - so correcting a Full shortage cannot come out of the
  // highlight quota or the other way round.
  const fullEntries = plan.filter(isFullLane);
  const hlEntries = plan.filter((entry) => !isFullLane(entry));
  const sum = (entries) => entries.reduce((acc, entry) => acc + Number(entry.count || 0), 0);
  const fullTotal = sum(fullEntries);
  const hlTotal = total - fullTotal;

  const out = [];
  for (const [entries, groupTotal, koStock, jaStock] of [
    [fullEntries, fullTotal, Number(counts.ko_full) || 0, Number(counts.ja_full) || 0],
    [hlEntries, hlTotal, Number(counts.ko_hl) || 0, Number(counts.ja_hl) || 0]
  ]) {
    if (!entries.length || groupTotal <= 0) { out.push(...entries); continue; }
    const split = splitByStock(entries, groupTotal, koStock, jaStock);
    if (!split.koEntries.length || !split.jaEntries.length) { out.push(...entries); continue; }
    out.push(...scaleGroup(split.jaEntries, split.jaTotal), ...scaleGroup(split.koEntries, split.koTotal));
  }
  return out.filter((entry) => entry.count > 0);
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
