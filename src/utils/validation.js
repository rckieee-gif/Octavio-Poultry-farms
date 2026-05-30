function toDateOnly(value) {
  if (!value) return value;
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

function addDays(dateText, days) {
  if (!dateText) return '';
  const date = new Date(`${dateText}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function sendCsv(res, filename, rows) {
  const headers = rows.length ? Object.keys(rows[0]) : ['message'];
  const bodyRows = rows.length ? rows : [{ message: 'No records found' }];
  const csv = [
    headers.map(csvEscape).join(','),
    ...bodyRows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

module.exports = {
  toDateOnly,
  addDays,
  csvEscape,
  sendCsv,
};
