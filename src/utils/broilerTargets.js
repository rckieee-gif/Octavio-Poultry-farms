const BAG_WEIGHT_KG = 50;

const BROILER_TARGETS = [
  { day: 1, weightGrams: 53, bagsPerThousandHeads: 0.3, fcr: 0.28 },
  { day: 2, weightGrams: 67, bagsPerThousandHeads: 0.64, fcr: 0.47 },
  { day: 3, weightGrams: 83, bagsPerThousandHeads: 1.04, fcr: 0.62 },
  { day: 4, weightGrams: 101, bagsPerThousandHeads: 1.48, fcr: 0.73 },
  { day: 5, weightGrams: 121, bagsPerThousandHeads: 1.96, fcr: 0.81 },
  { day: 6, weightGrams: 143, bagsPerThousandHeads: 2.48, fcr: 0.87 },
  { day: 7, weightGrams: 168, bagsPerThousandHeads: 3.06, fcr: 0.91 },
  { day: 8, weightGrams: 196, bagsPerThousandHeads: 3.68, fcr: 0.94 },
  { day: 9, weightGrams: 227, bagsPerThousandHeads: 4.36, fcr: 0.96 },
  { day: 10, weightGrams: 261, bagsPerThousandHeads: 5.12, fcr: 0.98 },
  { day: 11, weightGrams: 299, bagsPerThousandHeads: 5.98, fcr: 1 },
  { day: 12, weightGrams: 341, bagsPerThousandHeads: 6.94, fcr: 1.02 },
  { day: 13, weightGrams: 387, bagsPerThousandHeads: 8.02, fcr: 1.04 },
  { day: 14, weightGrams: 436, bagsPerThousandHeads: 9.22, fcr: 1.06 },
  { day: 15, weightGrams: 488, bagsPerThousandHeads: 10.56, fcr: 1.08 },
  { day: 16, weightGrams: 543, bagsPerThousandHeads: 12.06, fcr: 1.11 },
  { day: 17, weightGrams: 601, bagsPerThousandHeads: 13.72, fcr: 1.14 },
  { day: 18, weightGrams: 662, bagsPerThousandHeads: 15.54, fcr: 1.21 },
  { day: 19, weightGrams: 726, bagsPerThousandHeads: 17.52, fcr: 1.24 },
  { day: 20, weightGrams: 793, bagsPerThousandHeads: 19.66, fcr: 1.27 },
  { day: 21, weightGrams: 863, bagsPerThousandHeads: 21.92, fcr: 1.3 },
  { day: 22, weightGrams: 934, bagsPerThousandHeads: 24.3, fcr: 1.33 },
  { day: 23, weightGrams: 1007, bagsPerThousandHeads: 26.78, fcr: 1.36 },
  { day: 24, weightGrams: 1081, bagsPerThousandHeads: 29.36, fcr: 1.39 },
  { day: 25, weightGrams: 1156, bagsPerThousandHeads: 32.04, fcr: 1.41 },
  { day: 26, weightGrams: 1232, bagsPerThousandHeads: 34.8, fcr: 1.44 },
  { day: 27, weightGrams: 1310, bagsPerThousandHeads: 37.64, fcr: 1.46 },
  { day: 28, weightGrams: 1389, bagsPerThousandHeads: 40.56, fcr: 1.48 },
  { day: 29, weightGrams: 1470, bagsPerThousandHeads: 43.56, fcr: 1.5 },
  { day: 30, weightGrams: 1552, bagsPerThousandHeads: 46.64, fcr: 1.52 },
  { day: 31, weightGrams: 1636, bagsPerThousandHeads: 49.8, fcr: 1.54 },
  { day: 32, weightGrams: 1721, bagsPerThousandHeads: 53.04, fcr: 1.56 },
  { day: 33, weightGrams: 1807, bagsPerThousandHeads: 56.34, fcr: 1.6 }
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseDateOnly(value) {
  if (!value) return null;
  const [year, month, day] = String(value).split('T')[0].split('-').map(Number);
  if (!year || !month || !day) return null;
  return Date.UTC(year, month - 1, day);
}

function getAgeDay(startDate, logDate) {
  const start = parseDateOnly(startDate);
  const current = parseDateOnly(logDate);
  if (start === null || current === null) return null;
  if (current < start) return null;
  return Math.floor((current - start) / MS_PER_DAY);
}

function getBroilerTarget(day) {
  const numericDay = Number(day);
  if (!Number.isFinite(numericDay) || numericDay < 0) return null;

  const guideDay = Math.floor(numericDay);
  if (guideDay === 0) {
    return { day: 0, weightGrams: null, bagsPerThousandHeads: 0, fcr: null };
  }
  return BROILER_TARGETS.find((target) => target.day === guideDay) || null;
}

function getLastBroilerTargetDay() {
  return BROILER_TARGETS[BROILER_TARGETS.length - 1].day;
}

function calculateTargetFeedForHeads(heads, day) {
  const target = getBroilerTarget(day);
  const headCount = Number(heads || 0);
  if (!target || headCount <= 0) return null;

  const targetBags = target.bagsPerThousandHeads * (headCount / 1000);
  const targetKg = targetBags * BAG_WEIGHT_KG;

  return {
    ...target,
    heads: headCount,
    targetBags,
    targetKg
  };
}

function calculateActualFcr(feedKg, liveHeads, averageWeightGrams) {
  const totalLiveWeightKg = Number(liveHeads || 0) * (Number(averageWeightGrams || 0) / 1000);
  if (totalLiveWeightKg <= 0) return null;
  return Number(feedKg || 0) / totalLiveWeightKg;
}

module.exports = {
  BAG_WEIGHT_KG,
  BROILER_TARGETS,
  getAgeDay,
  getBroilerTarget,
  getLastBroilerTargetDay,
  calculateTargetFeedForHeads,
  calculateActualFcr
};
