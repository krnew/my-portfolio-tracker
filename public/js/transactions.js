let allTx = [];
let pendingDeleteId = null;
let importPreviewRows = [];

const txBody = document.getElementById('tx-body');
const itemCount = document.getElementById('item-count');
const searchInput = document.getElementById('search');

function fmtNum(n, digits) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// ---------- render table ----------
function renderTable() {
  const q = searchInput.value.trim().toUpperCase();
  const rows = allTx
    .filter((t) => !q || t.ticker.toUpperCase().includes(q))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  itemCount.textContent = String(rows.length);

  if (rows.length === 0) {
    txBody.innerHTML = '<tr><td colspan="9" class="empty">No data available</td></tr>';
    return;
  }

  txBody.innerHTML = rows.map((t) => `
    <tr data-id="${t.id}">
      <td>${escapeHtml(t.date)}</td>
      <td>${escapeHtml(t.action)}</td>
      <td><strong>${escapeHtml(t.ticker)}</strong></td>
      <td class="num">${fmtNum(t.price, 2)}</td>
      <td>${escapeHtml(t.currency)}</td>
      <td class="num">${fmtNum(t.shares, 4)}</td>
      <td class="num">${fmtNum(t.commission, 2)}</td>
      <td class="col-note"><span class="clip" title="${escapeHtml(t.note)}">${escapeHtml(t.note)}</span></td>
      <td class="col-actions">
        <button class="icon-btn btn-edit" title="Edit">✏️</button>
        <button class="icon-btn btn-delete" title="Delete">🗑️</button>
      </td>
    </tr>
  `).join('');
}

async function loadAndRender() {
  txBody.innerHTML = '<tr><td colspan="9" class="empty">กำลังโหลด...</td></tr>';
  try {
    allTx = await Api.list();
    renderTable();
  } catch (e) {
    txBody.innerHTML = '<tr><td colspan="9" class="empty">โหลดข้อมูลไม่สำเร็จ: ' + escapeHtml(e.message) + '</td></tr>';
  }
}

searchInput.addEventListener('input', renderTable);

txBody.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const id = tr.dataset.id;
  const tx = allTx.find((t) => t.id === id);
  if (!tx) return;
  if (e.target.classList.contains('btn-edit')) openEditModal(tx);
  if (e.target.classList.contains('btn-delete')) openConfirmDelete(tx);
});

// ---------- add / edit modal ----------
const txOverlay = document.getElementById('tx-overlay');
const txForm = document.getElementById('tx-form');
const txError = document.getElementById('tx-error');
const priceInput = document.getElementById('f-price');
const sharesInput = document.getElementById('f-shares');
const totalPaidInput = document.getElementById('f-total-paid');
const priceFetchBtn = document.getElementById('f-price-fetch');
const priceFetchedNote = document.getElementById('f-price-fetched-note');
const stockFields = document.getElementById('stock-fields');
const goldFields = document.getElementById('gold-fields');
const goldGramsInput = document.getElementById('f-gold-grams');
const goldTotalInput = document.getElementById('f-gold-total');
const goldRateDisplay = document.getElementById('gold-rate-display');
const goldLivePriceEl = document.getElementById('gold-live-price');

function showError(box, msg) {
  box.textContent = msg;
  box.classList.add('show');
}
function hideError(box) { box.classList.remove('show'); box.textContent = ''; }

function showFetchNote(msg) {
  priceFetchedNote.textContent = msg;
  priceFetchedNote.style.display = 'block';
}
function hideFetchNote() {
  priceFetchedNote.style.display = 'none';
  priceFetchedNote.textContent = '';
}

// ---------- หุ้น/ทอง toggle ----------
// f-ticker/f-price/f-currency/f-shares stay the CANONICAL fields the submit
// handler reads either way - in gold mode they just live inside a hidden
// block and get written to from the gold-specific inputs below, so the
// submit handler and server payload shape never need to know this toggle
// exists at all.
let txType = 'stock';

function setTxType(type) {
  txType = type;
  document.querySelectorAll('#tx-type-toggle button').forEach((btn) => {
    const isActive = btn.dataset.type === type;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });
  stockFields.style.display = type === 'stock' ? 'block' : 'none';
  goldFields.style.display = type === 'gold' ? 'block' : 'none';

  if (type === 'gold') {
    document.getElementById('f-ticker').value = 'GOLD-THB';
    document.getElementById('f-currency').value = 'THB';
    recomputeGoldPrice(); // sync f-shares/f-price from whatever's already in the gold inputs
    loadGoldReferencePrice();
  } else if (document.getElementById('f-ticker').value === 'GOLD-THB') {
    // สลับกลับมาโหมดหุ้น: เคลียร์ ticker/currency ที่ตั้งไว้ตอนโหมดทอง ไม่ให้ค้าง
    document.getElementById('f-ticker').value = '';
    document.getElementById('f-currency').value = 'USD';
    priceInput.value = '';
    sharesInput.value = '';
  }
}
document.querySelectorAll('#tx-type-toggle button').forEach((btn) => {
  btn.addEventListener('click', () => setTxType(btn.dataset.type));
});

async function loadGoldReferencePrice() {
  goldLivePriceEl.textContent = 'กำลังโหลดราคาทองปัจจุบัน...';
  try {
    const res = await fetch('/api/prices?tickers=GOLD-THB');
    const json = await res.json();
    const p = json.prices && json.prices['GOLD-THB'];
    if (p && typeof p.price === 'number') {
      goldLivePriceEl.textContent = `ราคาทองตอนนี้ (สมาคมค้าทองคำ, รับซื้อคืน): ${fmtNum(p.price, 2)} บาท/กรัม`;
    } else {
      goldLivePriceEl.textContent = 'ดึงราคาทองปัจจุบันไม่ได้ตอนนี้ - กรอกจากใบเสร็จได้เลย';
    }
  } catch (e) {
    goldLivePriceEl.textContent = 'ดึงราคาทองปัจจุบันไม่ได้ตอนนี้ - กรอกจากใบเสร็จได้เลย';
  }
}

TickerSuggest.attach(document.getElementById('f-ticker'), {
  // A function, not a captured array: loadAndRender() reassigns allTx, so a
  // snapshot taken at attach-time would go stale after the first refresh.
  getLocal: () => allTx.map((t) => t.ticker),
  // เลือก GOLD-THB จากช่องค้นหาหุ้น (เผื่อพิมพ์ "gold"/"ทอง" ในโหมดหุ้นด้วยความเคยชิน)
  // -> สลับไปแท็บทองให้เองเลย ครบทั้ง currency และช่องกรอกที่เหมาะสมกว่า
  onPick: (item) => { if (item.symbol === 'GOLD-THB') setTxType('gold'); },
});

// ---------- โหมดหุ้น: "ยอดรวมที่จ่าย" -> คำนวณ Price ให้อัตโนมัติ (scratch, ไม่ส่งไป server) ----------
function recomputePriceFromTotal() {
  const total = Number(totalPaidInput.value);
  const shares = Number(sharesInput.value);
  if (totalPaidInput.value !== '' && shares > 0 && Number.isFinite(total)) {
    priceInput.value = total / shares;
  }
}
totalPaidInput.addEventListener('input', recomputePriceFromTotal);
sharesInput.addEventListener('input', recomputePriceFromTotal); // กรอกยอดรวมก่อน shares ทีหลังก็ต้องคำนวณให้
// แก้ Price เองตรงๆ = ยอดรวมที่เคยกรอกไว้ไม่ตรงกับ Price ใหม่แล้ว เคลียร์ทิ้งกันเลขค้างหลอกตา
priceInput.addEventListener('input', () => { totalPaidInput.value = ''; });

// ---------- โหมดทอง: กรัม + ยอดรวม(บาท) -> ราคา/กรัม ----------
function recomputeGoldPrice() {
  sharesInput.value = goldGramsInput.value; // sync เข้า f-shares เสมอ ไม่ว่าจะคำนวณราคาได้หรือยัง
  const grams = Number(goldGramsInput.value);
  const total = Number(goldTotalInput.value);
  if (grams > 0 && total > 0 && Number.isFinite(grams) && Number.isFinite(total)) {
    const rate = total / grams;
    priceInput.value = rate;
    goldRateDisplay.textContent = `ราคาต่อกรัม: ${fmtNum(rate, 2)} บาท`;
  } else {
    priceInput.value = '';
    goldRateDisplay.textContent = 'ราคาต่อกรัม: -';
  }
}
goldGramsInput.addEventListener('input', recomputeGoldPrice);
goldTotalInput.addEventListener('input', recomputeGoldPrice);

// ---------- โหมดหุ้น: ปุ่มดึงราคาปิดของวันที่เลือก (ค่าประมาณ ไม่ใช่ราคาที่ซื้อจริงเป๊ะ) ----------
// เลือกราคาปิดของวันที่ระบุ ถ้าวันนั้นตลาดปิด (เสาร์-อาทิตย์/วันหยุด) ให้ถอยไปใช้ราคาปิด
// ของวันทำการก่อนหน้าแทน - series จาก /api/history เรียงวันที่น้อยไปมากอยู่แล้ว
function closeOnDate(series, targetDate) {
  let found = null;
  for (const pt of series) {
    if (pt.date > targetDate) break;
    found = pt;
  }
  return found;
}

priceFetchBtn.addEventListener('click', async () => {
  const ticker = document.getElementById('f-ticker').value.trim().toUpperCase();
  const date = document.getElementById('f-date').value;
  if (!ticker || !date) { showFetchNote('กรอก Ticker และ Date ก่อน'); return; }
  showFetchNote('กำลังดึงราคา...');
  try {
    const res = await fetch('/api/history?tickers=' + encodeURIComponent(ticker) + '&start=' + encodeURIComponent(date));
    const json = await res.json();
    const series = Array.isArray(json[ticker]) ? json[ticker] : [];
    const hit = closeOnDate(series, date);
    if (!hit) { showFetchNote('ไม่พบราคาย้อนหลังของ ' + ticker + ' วันที่นี้'); return; }
    priceInput.value = hit.close;
    totalPaidInput.value = ''; // ราคามาจากแหล่งอื่นแล้ว ยอดรวมที่เคยกรอกไว้ไม่ตรงแล้ว
    showFetchNote(hit.date === date
      ? `ราคาปิด ${hit.date} = ${hit.close} (ค่าประมาณ ไม่ใช่ราคาที่ซื้อจริง)`
      : `วันที่เลือกตลาดปิด ใช้ราคาปิด ${hit.date} = ${hit.close} แทน (ค่าประมาณ)`);
  } catch (e) {
    showFetchNote('ดึงราคาไม่สำเร็จ ลองใหม่หรือกรอกเอง');
  }
});

function openAddModal() {
  TickerSuggest.close();
  txForm.reset();
  document.getElementById('f-id').value = '';
  document.getElementById('f-currency').value = 'USD';
  document.getElementById('f-commission').value = '0';
  goldGramsInput.value = '';
  goldTotalInput.value = '';
  document.getElementById('tx-modal-title').textContent = 'Add Transaction';
  hideError(txError);
  hideFetchNote();
  setTxType('stock'); // เปิดใหม่เริ่มที่โหมดหุ้นเสมอ
  txOverlay.classList.add('show');
  document.getElementById('f-date').focus();
}

function openEditModal(tx) {
  TickerSuggest.close();
  document.getElementById('f-id').value = tx.id;
  document.getElementById('f-date').value = tx.date;
  document.getElementById('f-action').value = tx.action;
  document.getElementById('f-commission').value = tx.commission;
  document.getElementById('f-note').value = tx.note;
  totalPaidInput.value = '';
  hideError(txError);
  hideFetchNote();

  if (tx.ticker === 'GOLD-THB') {
    goldGramsInput.value = tx.shares;
    goldTotalInput.value = (Number(tx.price) * Number(tx.shares)).toFixed(2); // ย้อนคำนวณยอดรวมจาก price/shares ที่เก็บไว้
    setTxType('gold'); // จะ sync f-shares/f-price ให้เองจากค่าที่เพิ่งตั้ง
  } else {
    goldGramsInput.value = '';
    goldTotalInput.value = '';
    document.getElementById('f-ticker').value = tx.ticker;
    document.getElementById('f-price').value = tx.price;
    document.getElementById('f-currency').value = tx.currency;
    document.getElementById('f-shares').value = tx.shares;
    setTxType('stock');
  }
  document.getElementById('tx-modal-title').textContent = 'Edit Transaction';
  txOverlay.classList.add('show');
}

function closeTxModal() {
  txOverlay.classList.remove('show');
  TickerSuggest.close();
  totalPaidInput.value = '';
  goldGramsInput.value = '';
  goldTotalInput.value = '';
  hideFetchNote();
}

document.getElementById('btn-add').addEventListener('click', openAddModal);
document.getElementById('tx-cancel').addEventListener('click', closeTxModal);

txForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError(txError);

  // f-ticker/f-shares ไม่มี native `required` แล้ว (เพราะตอนอยู่คนละโหมดนึงจะโดนซ่อน
  // ด้วย display:none - required บน element ที่ซ่อนอยู่ทำให้ browser throw "not
  // focusable" แทนที่จะ submit) เช็คเองตรงนี้แทน ข้อความก็เลือกให้ตรงโหมดที่เห็นอยู่
  if (txType === 'stock' && !document.getElementById('f-ticker').value.trim()) {
    showError(txError, 'กรอก Ticker ก่อน'); return;
  }
  if (!(Number(document.getElementById('f-shares').value) > 0)) {
    showError(txError, txType === 'gold' ? 'กรอกจำนวนกรัมก่อน' : 'กรอก Shares ก่อน'); return;
  }

  const id = document.getElementById('f-id').value;
  const data = {
    date: document.getElementById('f-date').value,
    action: document.getElementById('f-action').value,
    ticker: document.getElementById('f-ticker').value.trim(),
    price: Number(document.getElementById('f-price').value),
    currency: document.getElementById('f-currency').value.trim() || 'USD',
    shares: Number(document.getElementById('f-shares').value),
    commission: Number(document.getElementById('f-commission').value || 0),
    note: document.getElementById('f-note').value.trim(),
  };
  try {
    if (id) await Api.update(id, data);
    else await Api.create(data);
    closeTxModal();
    await loadAndRender();
  } catch (err) {
    showError(txError, err.message);
  }
});

// ---------- delete confirm ----------
const confirmOverlay = document.getElementById('confirm-overlay');

function openConfirmDelete(tx) {
  pendingDeleteId = tx.id;
  document.getElementById('confirm-text').textContent =
    `${tx.date} · ${tx.action} · ${tx.ticker} · ${tx.shares} shares`;
  confirmOverlay.classList.add('show');
}

document.getElementById('confirm-cancel').addEventListener('click', () => {
  pendingDeleteId = null;
  confirmOverlay.classList.remove('show');
});

document.getElementById('confirm-delete').addEventListener('click', async () => {
  if (!pendingDeleteId) return;
  try {
    await Api.remove(pendingDeleteId);
    confirmOverlay.classList.remove('show');
    pendingDeleteId = null;
    await loadAndRender();
  } catch (err) {
    confirmOverlay.classList.remove('show');
    alert('ลบไม่สำเร็จ: ' + err.message);
  }
});

// ---------- import CSV ----------
const importOverlay = document.getElementById('import-overlay');
const importFile = document.getElementById('import-file');
const importBody = document.getElementById('import-body');
const importSummary = document.getElementById('import-summary');
const importError = document.getElementById('import-error');

const FIELD_ALIASES = {
  date: ['date'],
  action: ['action', 'type'],
  ticker: ['ticker', 'symbol'],
  price: ['price'],
  currency: ['currency'],
  shares: ['shares', 'qty', 'quantity'],
  commission: ['commission', 'fee', 'fees'],
  note: ['note', 'notes'],
};

function buildHeaderMap(headers) {
  const lower = headers.map((h) => h.trim().toLowerCase());
  const map = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      const idx = lower.indexOf(alias);
      if (idx !== -1) { map[field] = headers[idx]; break; }
    }
  }
  return map;
}

function normalizeAction(raw) {
  const s = (raw || '').trim().toLowerCase();
  if (s === 'buy') return 'Buy';
  if (s === 'sell') return 'Sell';
  if (['transfer in', 'transfer_in', 'transferin'].includes(s)) return 'Transfer in';
  if (['transfer out', 'transfer_out', 'transferout'].includes(s)) return 'Transfer out';
  return null;
}

function mapImportRow(obj, headerMap) {
  const get = (key) => (headerMap[key] ? (obj[headerMap[key]] || '').trim() : '');
  const date = get('date');
  const actionRaw = get('action');
  const action = normalizeAction(actionRaw);
  const ticker = get('ticker').toUpperCase();
  const priceRaw = get('price');
  const price = priceRaw === '' ? 0 : Number(priceRaw);
  const currency = get('currency') || 'USD';
  const shares = Number(get('shares'));
  const commissionRaw = get('commission');
  const commission = commissionRaw === '' ? 0 : Number(commissionRaw);
  const note = get('note');

  const reasons = [];
  if (!date) reasons.push('ไม่มีวันที่');
  if (!action) reasons.push('action ไม่รู้จัก' + (actionRaw ? ' (' + actionRaw + ')' : ''));
  if (!ticker) reasons.push('ไม่มี ticker');
  if (!Number.isFinite(shares) || shares <= 0) reasons.push('shares ไม่ถูกต้อง');
  if (!Number.isFinite(price) || price < 0) reasons.push('price ไม่ถูกต้อง');

  return {
    valid: reasons.length === 0,
    reason: reasons.join(', '),
    row: { date, action: action || actionRaw, ticker, price: Number.isFinite(price) ? price : 0, currency, shares: Number.isFinite(shares) ? shares : 0, commission: Number.isFinite(commission) ? commission : 0, note },
  };
}

document.getElementById('btn-import').addEventListener('click', () => importFile.click());

// Composite key used only to spot likely duplicates in the import preview -
// not a uniqueness constraint on the ledger itself (a real same-day repeat
// buy is legitimate, so duplicates are flagged and unchecked, never blocked).
function txKey(row) {
  return [row.date, row.action, row.ticker, Number(row.shares).toFixed(6), Number(row.price).toFixed(6)].join('|');
}

importFile.addEventListener('change', () => {
  const file = importFile.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    hideError(importError);
    const { headers, objects } = CSVUtil.toObjects(String(reader.result));
    if (headers.length === 0) {
      showError(importError, 'อ่านไฟล์ไม่ได้ หรือไฟล์ว่างเปล่า');
      return;
    }
    const headerMap = buildHeaderMap(headers);
    if (!headerMap.date || !headerMap.ticker || !headerMap.shares) {
      showError(importError, 'ไม่พบคอลัมน์ date/ticker/shares ในไฟล์ (ตรวจสอบหัวตาราง CSV)');
      return;
    }
    const existingKeys = new Set(allTx.map(txKey));
    const mapped = objects.map((o) => mapImportRow(o, headerMap));
    mapped.forEach((m) => { if (m.valid) m.isDuplicate = existingKeys.has(txKey(m.row)); });
    importPreviewRows = mapped;

    const validCount = mapped.filter((m) => m.valid).length;
    const dupCount = mapped.filter((m) => m.isDuplicate).length;
    const skipCount = mapped.length - validCount;

    importSummary.textContent = `พบ ${mapped.length} แถว — ถูกต้อง ${validCount} แถว (ในนั้นซ้ำกับข้อมูลเดิม ${dupCount} แถว ไม่ติ๊กให้อัตโนมัติ), ข้าม ${skipCount} แถว`;
    importBody.innerHTML = mapped.map((m, i) => `
      <tr class="${m.valid ? '' : 'skip-row'}">
        <td>${m.valid ? `<input type="checkbox" class="import-row-check" data-idx="${i}" ${m.isDuplicate ? '' : 'checked'}>` : ''}</td>
        <td>${escapeHtml(m.row.date)}</td>
        <td>${escapeHtml(m.row.action)}</td>
        <td>${escapeHtml(m.row.ticker)}</td>
        <td>${escapeHtml(m.row.price)}</td>
        <td>${escapeHtml(m.row.shares)}</td>
        <td>${m.valid ? (m.isDuplicate ? 'ซ้ำกับรายการเดิม' : 'OK') : 'ข้าม: ' + escapeHtml(m.reason)}</td>
      </tr>
    `).join('');
    importOverlay.classList.add('show');
  };
  reader.readAsText(file);
  importFile.value = '';
});

document.getElementById('import-cancel').addEventListener('click', () => {
  importOverlay.classList.remove('show');
  importPreviewRows = [];
});

document.getElementById('import-confirm').addEventListener('click', async () => {
  const checkedIdx = Array.from(document.querySelectorAll('.import-row-check:checked')).map((el) => Number(el.dataset.idx));
  const rows = checkedIdx.map((i) => importPreviewRows[i].row);
  if (rows.length === 0) { importOverlay.classList.remove('show'); importPreviewRows = []; return; }
  try {
    await Api.bulkImport(rows);
    importOverlay.classList.remove('show');
    importPreviewRows = [];
    await loadAndRender();
  } catch (err) {
    showError(importError, err.message);
  }
});

loadAndRender();
