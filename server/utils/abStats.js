// Track B duration A/B statistics (PLAYBOOK.md section 3): primary test is
// paired (Wilcoxon signed-rank) since pairs share a source video, which
// cancels out material/channel confounding within the pair -- see the
// duration-confound-check findings that motivated this design. Mann-Whitney U
// is a secondary/fallback test for any leftover unpaired sample (e.g. one
// member of a pair dropped but the other still has usable solo data outside
// the paired analysis).

// Standard normal CDF via the Abramowitz-Stegun erf approximation -- accurate
// to ~1e-7, plenty for a p-value used against a 0.05 threshold.
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

// Two-sided p-value from a signed z statistic.
function twoSidedPFromZ(z) {
  return 2 * (1 - normalCdf(Math.abs(z)));
}

// Wilcoxon signed-rank test, normal approximation (valid for n >= ~10, which
// fits the target n=30 pairs). diffs = array of (T - C) per pair. Ties at
// zero are dropped per the standard procedure; tied |diff| values share the
// average rank, with a continuity/tie correction applied to the variance.
function wilcoxonSignedRank(diffs) {
  const nonZero = diffs.filter((d) => d !== 0);
  const n = nonZero.length;
  if (n < 1) {
    return { n: 0, W: null, z: null, p: null, medianDiff: null, note: 'no non-zero differences' };
  }

  const abs = nonZero.map((d) => Math.abs(d));
  const sorted = abs
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);

  // assign average ranks for ties
  const ranks = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && sorted[j + 1].value === sorted[i].value) j += 1;
    const avgRank = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k += 1) ranks[sorted[k].index] = avgRank;
    i = j + 1;
  }

  let wPlus = 0;
  let wMinus = 0;
  nonZero.forEach((d, idx) => {
    if (d > 0) wPlus += ranks[idx];
    else wMinus += ranks[idx];
  });
  const W = Math.min(wPlus, wMinus);

  const meanW = (n * (n + 1)) / 4;
  // tie correction
  const tieGroups = new Map();
  abs.forEach((value) => tieGroups.set(value, (tieGroups.get(value) || 0) + 1));
  let tieCorrection = 0;
  for (const count of tieGroups.values()) {
    if (count > 1) tieCorrection += (count * count * count - count);
  }
  const variance = (n * (n + 1) * (2 * n + 1)) / 24 - tieCorrection / 48;
  const sd = Math.sqrt(Math.max(variance, 1e-9));
  // continuity correction toward the mean
  const z = (W - meanW + (W < meanW ? 0.5 : -0.5)) / sd;
  const p = twoSidedPFromZ(z);

  const sortedDiffs = [...diffs].sort((a, b) => a - b);
  const mid = Math.floor(sortedDiffs.length / 2);
  const medianDiff = sortedDiffs.length % 2 === 0
    ? (sortedDiffs[mid - 1] + sortedDiffs[mid]) / 2
    : sortedDiffs[mid];

  return { n, W, wPlus, wMinus, z, p, medianDiff };
}

// Mann-Whitney U, normal approximation. groupA/groupB are arrays of numbers
// (unpaired -- used only as a fallback over broken-pair leftovers, not the
// primary test).
function mannWhitneyU(groupA, groupB) {
  const nA = groupA.length;
  const nB = groupB.length;
  if (nA < 1 || nB < 1) {
    return { nA, nB, U: null, z: null, p: null };
  }
  const combined = [
    ...groupA.map((value) => ({ value, group: 'A' })),
    ...groupB.map((value) => ({ value, group: 'B' }))
  ].sort((a, b) => a.value - b.value);

  const ranks = new Array(combined.length);
  let i = 0;
  while (i < combined.length) {
    let j = i;
    while (j + 1 < combined.length && combined[j + 1].value === combined[i].value) j += 1;
    const avgRank = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k += 1) ranks[k] = avgRank;
    i = j + 1;
  }

  let rankSumA = 0;
  combined.forEach((item, idx) => { if (item.group === 'A') rankSumA += ranks[idx]; });

  const uA = rankSumA - (nA * (nA + 1)) / 2;
  const uB = nA * nB - uA;
  const U = Math.min(uA, uB);

  const meanU = (nA * nB) / 2;
  const varU = (nA * nB * (nA + nB + 1)) / 12;
  const sd = Math.sqrt(Math.max(varU, 1e-9));
  const z = (U - meanU + 0.5) / sd;
  const p = twoSidedPFromZ(z);

  return { nA, nB, U, z, p };
}

module.exports = { wilcoxonSignedRank, mannWhitneyU };
