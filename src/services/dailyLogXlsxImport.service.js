const ExcelJS = require('exceljs');

const DAILY_LOG_SHEET_NAME = 'Daily Log';
const SETUP_SHEET_NAME = 'Setup';
const DEFAULT_FEED_ITEM = 'Starter Feed';

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function resolveCellValue(value) {
  if (value instanceof Date) return value;
  if (!value || typeof value !== 'object') return value;
  if (Object.prototype.hasOwnProperty.call(value, 'result')) return resolveCellValue(value.result);
  if (Object.prototype.hasOwnProperty.call(value, 'text')) return value.text;
  if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');
  return value;
}

function getCellValue(rowOrWorksheet, cellRef) {
  return resolveCellValue(rowOrWorksheet.getCell(cellRef).value);
}

function getCellText(rowOrWorksheet, cellRef) {
  const value = getCellValue(rowOrWorksheet, cellRef);
  if (isBlank(value)) return '';
  if (value instanceof Date) return formatDateParts(value.getFullYear(), value.getMonth() + 1, value.getDate());
  return String(value).trim();
}

function formatDateParts(year, month, day) {
  if (!year || !month || !day) return '';
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function excelSerialDateToIso(value) {
  const serial = Number(value);
  if (!Number.isFinite(serial)) return '';

  const utcDays = Math.floor(serial - 25569);
  const date = new Date(utcDays * 86400 * 1000);
  if (Number.isNaN(date.getTime())) return '';

  return formatDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function parseDateCell(value) {
  const resolved = resolveCellValue(value);
  if (resolved instanceof Date) {
    return formatDateParts(resolved.getFullYear(), resolved.getMonth() + 1, resolved.getDate());
  }

  if (typeof resolved === 'number') return excelSerialDateToIso(resolved);

  const text = String(resolved || '').trim();
  if (!text) return '';
  if (/^\d+(\.\d+)?$/.test(text)) return excelSerialDateToIso(Number(text));
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return '';
  return formatDateParts(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
}

function normalizeBuilding(value) {
  const text = String(value || '').trim();
  const upper = text.toUpperCase();
  const labelled = upper.match(/\b(?:BLD|BUILDING)\s*[-_#]?\s*([A-Z])\b/);
  if (labelled) return labelled[1];
  const cageLike = upper.match(/^([A-Z])[-_\s]?\d/);
  if (cageLike) return cageLike[1];
  return text;
}

function normalizeNumber(value, fallback = 0) {
  const number = Number(resolveCellValue(value));
  return Number.isFinite(number) ? number : fallback;
}

function normalizeInteger(value, fallback = 0) {
  return Math.round(normalizeNumber(value, fallback));
}

function appendRemark(parts, label, value) {
  const text = String(resolveCellValue(value) || '').trim();
  if (text) parts.push(`${label}: ${text}`);
}

function validateDailyLogTemplate(dailySheet) {
  const requiredHeaders = [
    ['A3', 'Date'],
    ['C3', 'Flockman'],
    ['D3', 'Cage ID'],
    ['E3', 'Building ID'],
    ['F3', 'Birds Start'],
    ['G3', 'Deaths'],
    ['J3', 'Feed Given (Sacks)'],
  ];

  const missing = requiredHeaders
    .filter(([cellRef, label]) => getCellText(dailySheet, cellRef).toLowerCase() !== label.toLowerCase())
    .map(([, label]) => label);

  if (missing.length > 0) {
    throw new Error(`Daily Log worksheet does not match the poultry monitoring template. Missing columns: ${missing.join(', ')}.`);
  }
}

function buildImportRow(row, batchId, defaultFeedItem) {
  const date = parseDateCell(getCellValue(row, 1));
  const employee = getCellText(row, 3);
  const cageId = getCellText(row, 4);
  const building = normalizeBuilding(getCellText(row, 5));

  if (!date || !employee || !cageId || !building) return null;

  const feedConsumed = normalizeNumber(getCellValue(row, 10));
  const remarks = [`Cage ${cageId}`];
  const transferOut = normalizeNumber(getCellValue(row, 8), 0);

  if (transferOut) remarks.push(`Transfer/out: ${transferOut}`);
  appendRemark(remarks, 'Weather', getCellValue(row, 17));
  appendRemark(remarks, 'Issue', getCellValue(row, 18));
  appendRemark(remarks, 'Note', getCellValue(row, 19));

  return {
    batch_id: batchId,
    date,
    building,
    employee,
    handled_birds_snapshot: normalizeInteger(getCellValue(row, 6)),
    feed_item: feedConsumed > 0 ? defaultFeedItem : '',
    feed_consumed: feedConsumed,
    mortality: normalizeInteger(getCellValue(row, 7)),
    average_weight_g: '',
    remarks: remarks.join(' | '),
    import_source_key: `poultry-daily-log:${date}:${cageId}`,
  };
}

async function parseDailyLogXlsx(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('A valid Excel workbook is required.');
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const setupSheet = workbook.getWorksheet(SETUP_SHEET_NAME);
  const dailySheet = workbook.getWorksheet(DAILY_LOG_SHEET_NAME);

  if (!setupSheet) throw new Error(`Workbook is missing the "${SETUP_SHEET_NAME}" worksheet.`);
  if (!dailySheet) throw new Error(`Workbook is missing the "${DAILY_LOG_SHEET_NAME}" worksheet.`);

  validateDailyLogTemplate(dailySheet);

  const batchId = String(options.batchId || getCellValue(setupSheet, 'B3') || '').trim();
  if (!batchId) throw new Error('Workbook setup is missing an active batch ID in Setup!B3.');

  const defaultFeedItem = String(options.defaultFeedItem || DEFAULT_FEED_ITEM).trim() || DEFAULT_FEED_ITEM;
  const rows = [];

  for (let rowNumber = 4; rowNumber <= dailySheet.rowCount; rowNumber += 1) {
    const importRow = buildImportRow(dailySheet.getRow(rowNumber), batchId, defaultFeedItem);
    if (importRow) rows.push(importRow);
  }

  if (rows.length === 0) {
    throw new Error('No daily log rows were found in the Daily Log worksheet.');
  }

  return rows;
}

module.exports = {
  DEFAULT_FEED_ITEM,
  parseDailyLogXlsx,
};
