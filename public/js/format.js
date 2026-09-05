function fmtMoney(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtBaht(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  return '≈ ฿' + n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtShares(n) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}

function fmtPct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  const sign = n > 0 ? '+' : '';
  return sign + n.toFixed(2) + '%';
}

function signClass(n) { return n > 0 ? 'pos' : n < 0 ? 'neg' : ''; }

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Local calendar date as YYYY-MM-DD (NOT UTC - toISOString() forces UTC, which
// runs up to a day behind local time for any timezone ahead of UTC, e.g. every
// morning in Thailand before the UTC date rolls over).
function todayLocalISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function setTile(valueId, subId, value, sub, cls) {
  const valueEl = document.getElementById(valueId);
  const privacyClass = valueEl.classList.contains('privacy-sensitive') ? ' privacy-sensitive' : '';
  valueEl.textContent = value;
  valueEl.className = 'value' + (cls ? ' ' + cls : '') + privacyClass;
  if (subId) document.getElementById(subId).textContent = sub || '';
}
