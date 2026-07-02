const { csvEscape } = require('../utils/validation');

const DAILY_LOG_EXPORT_HEADERS = [
  'id',
  'batch_id',
  'date',
  'building',
  'employee',
  'handled_birds_snapshot',
  'feed_item',
  'feed_consumed',
  'mortality',
  'average_weight_g',
  'remarks',
  'created_at',
];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function getValue(row, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  }

  return undefined;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function parseSqlTimestampAsUtc(value) {
  if (typeof value !== 'string') return null;

  const match = value.trim().match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/
  );

  if (!match) return null;

  return new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] || 0),
    Number(match[5] || 0),
    Number(match[6] || 0)
  ));
}

function parseDateValue(value) {
  if (isBlank(value)) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const sqlDate = parseSqlTimestampAsUtc(String(value));
  if (sqlDate) return sqlDate;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatUtcTimestamp(value, { forceMidnight = false } = {}) {
  const date = parseDateValue(value);
  if (!date) return '';

  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const hours = forceMidnight ? 0 : date.getUTCHours();
  const minutes = forceMidnight ? 0 : date.getUTCMinutes();
  const seconds = forceMidnight ? 0 : date.getUTCSeconds();
  const normalized = new Date(Date.UTC(year, month, day, hours, minutes, seconds));

  return `${DAY_NAMES[normalized.getUTCDay()]} ${MONTH_NAMES[month]} ${pad2(day)} ${year} ${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)} GMT+0000 (Coordinated Universal Time)`;
}

function normalizeExportBuilding(value) {
  if (isBlank(value)) return '';

  const text = String(value).trim();
  const upper = text.toUpperCase();

  if (upper === 'ALL') return 'All';
  if (/^[A-Z]$/.test(upper)) return upper;

  const labelled = upper.match(/\b(?:BUILDING|BLD)\s*[-_#]?\s*([A-Z])\b/);
  if (labelled) return labelled[1];

  const prefixed = upper.match(/^([A-Z])(?:[-_\s]?\d|\b)/);
  if (prefixed) return prefixed[1];

  return text;
}

function formatDecimal2(value) {
  if (isBlank(value)) return '';

  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : '';
}

function formatInteger(value) {
  if (isBlank(value)) return '';

  const number = Number(value);
  return Number.isFinite(number) ? String(Math.round(number)) : '';
}

function formatPlainValue(value) {
  return isBlank(value) ? '' : String(value);
}

function getSortableId(row) {
  const id = Number(getValue(row, 'id'));
  return Number.isFinite(id) ? id : null;
}

function getSortableCreatedAt(row) {
  const date = parseDateValue(getValue(row, 'created_at', 'createdAt'));
  return date ? date.getTime() : 0;
}

function compareDailyLogRows(left, right) {
  const leftId = getSortableId(left);
  const rightId = getSortableId(right);

  if (leftId !== null && rightId !== null && leftId !== rightId) {
    return rightId - leftId;
  }

  if (leftId !== null && rightId === null) return -1;
  if (leftId === null && rightId !== null) return 1;

  return getSortableCreatedAt(right) - getSortableCreatedAt(left);
}

function formatDailyLogExportRow(row) {
  return {
    id: formatPlainValue(getValue(row, 'id')),
    batch_id: formatPlainValue(getValue(row, 'batch_id', 'batchId')),
    date: formatUtcTimestamp(getValue(row, 'date'), { forceMidnight: true }),
    building: normalizeExportBuilding(getValue(row, 'building')),
    employee: formatPlainValue(getValue(row, 'employee', 'employeeName', 'employee_name')),
    handled_birds_snapshot: formatInteger(getValue(row, 'handled_birds_snapshot', 'handledBirds')),
    feed_item: formatPlainValue(getValue(row, 'feed_item', 'feedItemName', 'feed_item_name')),
    feed_consumed: formatDecimal2(getValue(row, 'feed_consumed', 'feed', 'feedConsumed')),
    mortality: formatInteger(getValue(row, 'mortality')),
    average_weight_g: formatPlainValue(getValue(row, 'average_weight_g', 'averageWeightGrams')),
    remarks: formatPlainValue(getValue(row, 'remarks')),
    created_at: formatUtcTimestamp(getValue(row, 'created_at', 'createdAt')),
  };
}

function formatDailyLogExportRows(rows) {
  return [...(rows || [])]
    .sort(compareDailyLogRows)
    .map(formatDailyLogExportRow);
}

function buildDailyLogsCsv(rows) {
  const formattedRows = formatDailyLogExportRows(rows);
  return [
    DAILY_LOG_EXPORT_HEADERS.map(csvEscape).join(','),
    ...formattedRows.map((row) => DAILY_LOG_EXPORT_HEADERS.map((header) => csvEscape(row[header])).join(',')),
  ].join('\r\n');
}

function sendDailyLogsCsv(res, filename, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buildDailyLogsCsv(rows));
}

module.exports = {
  DAILY_LOG_EXPORT_HEADERS,
  buildDailyLogsCsv,
  compareDailyLogRows,
  formatDailyLogExportRow,
  formatDailyLogExportRows,
  formatUtcTimestamp,
  normalizeExportBuilding,
  sendDailyLogsCsv,
};
