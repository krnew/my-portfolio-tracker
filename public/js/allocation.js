// Categorical palette validated via the dataviz skill's validate_palette.js
// (adjacent-pair CVD safe, fixed hue order - never reassign per filter/sort).
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const OTHER_COLOR = '#898781';
const MAX_SLOTS = 8;

// มุมมองที่ดูได้: เงินอยู่ตรงไหนตอนนี้ (มูลค่าตลาด), ตอนซื้อเราตั้งใจแบ่งยังไง
// (ต้นทุน), และกำไร/ขาดทุนที่มีอยู่มาจากตัวไหน
//
// กำไรกับขาดทุนต้องแยกเป็นคนละมุมมอง ไม่ใช่รวมในโดนัทเดียว - โดนัทแสดง "ส่วนของ
// ทั้งหมด" ได้เฉพาะค่าบวก ถ้าเอาค่าลบมาปนสัดส่วนจะไม่มีความหมายเลย
const BASIS = {
  value: { label: 'มูลค่าตลาด', pick: (r) => r.marketValue, title: 'สัดส่วนตามมูลค่าตลาด' },
  cost: { label: 'ต้นทุน', pick: (r) => r.costBasis, title: 'สัดส่วนตามเงินที่ลงไป' },
  gain: { label: 'กำไร', pick: (r) => (r.unrealizedGain > 0 ? r.unrealizedGain : null), title: 'กำไรที่ยังไม่ขาย มาจากตัวไหน' },
  loss: { label: 'ขาดทุน', pick: (r) => (r.unrealizedGain < 0 ? -r.unrealizedGain : null), title: 'ขาดทุนที่ยังไม่ขาย มาจากตัวไหน' },
};

const GROUPS = {
  ticker: { label: 'รายตัว', key: (r) => r.ticker },
  type: { label: 'ประเภทสินทรัพย์', key: (r) => r.assetType },
  currency: { label: 'สกุลเงินที่ซื้อ', key: (r) => r.tradeCurrency },
};

let currentBasis = 'value';
let currentGroup = 'ticker';
let currentRows = [];

// Yahoo ส่ง instrumentType มากับราคาอยู่แล้ว (server.js) แต่ราคาที่อยู่ใน cache
// ตั้งแต่ก่อนเพิ่มฟิลด์นี้จะไม่มีค่า จึงต้องมีทางสำรองที่เดาจากรูปแบบ ticker
function assetTypeOf(ticker, priceEntry) {
  if (ticker === 'GOLD-THB') return 'ทองคำ';
  const t = String((priceEntry && priceEntry.type) || '').toUpperCase();
  if (t === 'CRYPTOCURRENCY') return 'คริปโต';
  if (t === 'ETF') return 'กองทุน ETF';
  if (t === 'MUTUALFUND') return 'กองทุนรวม';
  if (t === 'EQUITY') return 'หุ้นรายตัว';
  if (t === 'INDEX') return 'ดัชนี';
  if (/-USD$/.test(ticker)) return 'คริปโต';
  return 'อื่น ๆ';
}

// รวมแถวเป็นก้อนตามมิติที่เลือก แล้วยุบส่วนหางเป็น "อื่น ๆ" เมื่อเกินจำนวนสีที่มี
// (สีที่ 9 ที่สร้างเพิ่มเองจะแยกจากสีเดิมไม่ออกสำหรับคนตาบอดสี)
function aggregate(rows, basisKey, groupKey) {
  const pick = BASIS[basisKey].pick;
  const keyOf = GROUPS[groupKey].key;

  const byKey = new Map();
  rows.forEach((r) => {
    const amount = pick(r);
    if (amount === null || amount === undefined || !(amount > 0)) return;
    const k = keyOf(r) || 'ไม่ระบุ';
    if (!byKey.has(k)) byKey.set(k, { label: k, amount: 0, members: [] });
    const bucket = byKey.get(k);
    bucket.amount += amount;
    bucket.members.push(r.ticker);
  });

  const sorted = [...byKey.values()].sort((a, b) => b.amount - a.amount);
  const total = sorted.reduce((s, r) => s + r.amount, 0);

  let shaped = sorted;
  if (sorted.length > MAX_SLOTS) {
    const tail = sorted.slice(MAX_SLOTS - 1);
    shaped = sorted.slice(0, MAX_SLOTS - 1).concat([{
      label: `อื่น ๆ (${tail.length})`,
      amount: tail.reduce((s, r) => s + r.amount, 0),
      members: tail.flatMap((r) => r.members),
      isOther: true,
    }]);
  }

  return {
    total,
    segments: shaped.map((r, i) => ({
      ...r,
      color: r.isOther ? OTHER_COLOR : PALETTE[i],
      pct: total > 0 ? (r.amount / total) * 100 : 0,
    })),
  };
}

// Donut via the stroke-dasharray-on-a-circle idiom: each segment is a ring
// slice, rotated -90deg so the first segment starts at 12 o'clock. External
// leader-line labels only for segments >=8% - small slices stay readable via
// the legend below instead of crowding the chart.
function renderDonut(segments) {
  const svg = document.getElementById('alloc-donut');
  const total = segments.reduce((s, r) => s + r.pct, 0) || 1;
  const cx = 200, cy = 140, r = 75, strokeWidth = 35, labelR = r + 25;
  const circumference = 2 * Math.PI * r;

  let cumulativePct = 0;
  const arcs = [];
  const labels = [];

  segments.forEach((seg) => {
    const pct = seg.pct;
    const segLen = (pct / total) * circumference;
    const dashArray = `${segLen.toFixed(2)} ${(circumference - segLen).toFixed(2)}`;
    const dashOffset = (-((cumulativePct / total) * circumference)).toFixed(2);
    arcs.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${seg.color}" stroke-width="${strokeWidth}" stroke-dasharray="${dashArray}" stroke-dashoffset="${dashOffset}" transform="rotate(-90 ${cx} ${cy})"><title>${escapeHtml(seg.label)} - ${pct.toFixed(1)}%</title></circle>`);

    if (pct >= 8) {
      const midFrac = (cumulativePct + pct / 2) / total;
      const angle = midFrac * 2 * Math.PI - Math.PI / 2;
      const lx1 = cx + r * Math.cos(angle);
      const ly1 = cy + r * Math.sin(angle);
      const lx2 = cx + labelR * Math.cos(angle);
      const ly2 = cy + labelR * Math.sin(angle);
      const anchor = Math.cos(angle) >= 0 ? 'start' : 'end';
      const tx = lx2 + (anchor === 'start' ? 6 : -6);
      // stroke is --hairline, fill below is --ink (SVG attrs, no CSS var() support here)
      labels.push(`<line x1="${lx1.toFixed(1)}" y1="${ly1.toFixed(1)}" x2="${lx2.toFixed(1)}" y2="${ly2.toFixed(1)}" stroke="#e6dfd8" stroke-width="1" />`);
      labels.push(`<text x="${tx.toFixed(1)}" y="${ly2.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle" style="font-size:12px; font-weight:600; fill:#141413;">${escapeHtml(seg.label)}: ${pct.toFixed(1)}%</text>`);
    }
    cumulativePct += pct;
  });

  svg.innerHTML = arcs.join('') + labels.join('');
}

function renderView() {
  const svg = document.getElementById('alloc-donut');
  const legend = document.getElementById('alloc-legend');
  const emptyNote = document.getElementById('alloc-empty-note');
  const { total, segments } = aggregate(currentRows, currentBasis, currentGroup);

  document.getElementById('alloc-chart-title').textContent = BASIS[currentBasis].title;

  if (segments.length === 0) {
    svg.innerHTML = '';
    legend.innerHTML = '';
    emptyNote.style.display = 'block';
    emptyNote.textContent = currentBasis === 'gain' ? 'ตอนนี้ยังไม่มีสินทรัพย์ตัวไหนที่กำไร'
      : currentBasis === 'loss' ? 'ตอนนี้ไม่มีสินทรัพย์ตัวไหนที่ขาดทุน — ดีแล้ว'
        : 'ไม่มีข้อมูลพอสำหรับมุมมองนี้';
    return;
  }
  emptyNote.style.display = 'none';

  renderDonut(segments);
  legend.innerHTML = segments.map((seg) => `
    <div class="item">
      <span class="swatch" style="background:${seg.color}"></span>
      <span title="${escapeHtml(seg.members.join(', '))}">${escapeHtml(seg.label)}</span>
      <span class="pct">${seg.pct.toFixed(1)}%</span>
    </div>
  `).join('');

  document.getElementById('alloc-total').textContent =
    `รวม ${fmtMoney(total)} · ${segments.length} กลุ่ม`;
}

function renderTable(rows) {
  const body = document.getElementById('alloc-body');
  const totalCost = rows.reduce((s, r) => s + Math.max(0, r.costBasis), 0);

  body.innerHTML = rows.map((r) => {
    const costPct = totalCost > 0 ? (Math.max(0, r.costBasis) / totalCost) * 100 : 0;
    // สัดส่วนที่ "เขยิบ" ไปจากตอนซื้อ - ตัวเลขที่บอกว่าตัวไหนวิ่งจนกินพอร์ตเกิน
    // ที่ตั้งใจไว้ ซึ่งเป็นสัญญาณว่าถึงเวลาปรับสมดุลแล้ว
    const drift = r.marketValue !== null ? r.allocationPct - costPct : null;
    return `
      <tr>
        <td><strong>${escapeHtml(r.ticker)}</strong>${r.stale ? ' <span title="ราคาช้า อาจไม่ใช่ล่าสุด">⚠️</span>' : ''}<div class="sub-cell">${escapeHtml(r.assetType)}</div></td>
        <td class="num">${r.marketValue !== null ? r.allocationPct.toFixed(1) + '%' : '-'}</td>
        <td class="num">${costPct.toFixed(1)}%</td>
        <td class="num ${drift === null ? '' : signClass(drift)}">${drift === null ? '-' : fmtPct(drift)}</td>
        <td class="num">${fmtShares(r.shares)}</td>
        <td class="num">${fmtMoney(r.avgCost)}</td>
        <td class="num">${r.price !== null ? fmtMoney(r.price) : 'N/A'}</td>
        <td class="num">${r.marketValue !== null ? fmtMoney(r.marketValue) : 'N/A'}</td>
        <td class="num ${r.unrealizedGain !== null ? signClass(r.unrealizedGain) : ''}">${r.unrealizedGain !== null ? fmtMoney(r.unrealizedGain) : 'N/A'}</td>
      </tr>
    `;
  }).join('');
}

function setupToggles() {
  document.querySelectorAll('#basis-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#basis-toggle button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentBasis = btn.dataset.basis;
      renderView();
    });
  });
  document.querySelectorAll('#group-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#group-toggle button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentGroup = btn.dataset.group;
      renderView();
    });
  });
}

async function render() {
  const body = document.getElementById('alloc-body');

  try {
    const raw = await Api.list();
    const { transactions, droppedCount } = await Currency.normalizeTransactions(raw);

    // สกุลเงินที่ "ซื้อจริง" หายไปหลัง normalize (ทุกอย่างกลายเป็น USD) จึงต้อง
    // เก็บจากเลดเจอร์ดิบไว้ก่อน ใช้ตอนจัดกลุ่มตามสกุลเงิน
    const currencyByTicker = new Map();
    raw.forEach((t) => { if (t.ticker && t.currency) currencyByTicker.set(t.ticker, t.currency); });

    const holdings = Holdings.compute(transactions);
    const openTickers = holdings.filter((h) => h.shares > 1e-9).map((h) => h.ticker);

    let priceData = { prices: {}, fx: null };
    try { priceData = await Prices.fetchFor(openTickers); } catch (e) { /* fall back below */ }
    AppUI.updatePriceStatus(priceData.prices, priceData.fx);
    const rawPrices = priceData.prices;
    priceData.prices = Currency.normalizePrices(rawPrices, priceData.fx);

    const fxWarningEl = document.getElementById('alloc-fx-warning');
    if (droppedCount > 0) {
      fxWarningEl.textContent = `⚠️ ไม่รวม ${droppedCount} ธุรกรรมที่แปลงสกุลเงินเป็น USD ไม่ได้ (เน็ตล่มตอนโหลด)`;
      fxWarningEl.style.display = 'block';
    } else {
      fxWarningEl.style.display = 'none';
    }

    const p = Portfolio.enrich(holdings, priceData.prices);
    const rows = p.rows.filter((r) => r.shares > 1e-9).map((r) => ({
      ...r,
      // ประเภทสินทรัพย์อ่านจากราคา "ก่อน" แปลงสกุลเงิน เพราะ normalizePrices จะ
      // แทนที่รายการที่แปลงไม่ได้ด้วย {error} ซึ่งไม่มี type ติดมาด้วย
      assetType: assetTypeOf(r.ticker, rawPrices[r.ticker]),
      tradeCurrency: currencyByTicker.get(r.ticker) || 'USD',
    }));
    currentRows = rows;

    setTile('tile-value', 'tile-value-sub', fmtMoney(p.totalMarketValue),
      priceData.fx ? fmtBaht(p.totalMarketValue * priceData.fx.rate) : '');
    setTile('tile-count', null, String(rows.length));
    setTile('tile-unrealized', null, fmtMoney(p.totalUnrealizedGain), null, signClass(p.totalUnrealizedGain));

    const unpriced = rows.filter((r) => r.marketValue === null);
    const unpricedNote = document.getElementById('alloc-unpriced-note');
    if (unpriced.length > 0) {
      unpricedNote.textContent = `ไม่รวม ${unpriced.length} รายการที่ดึงราคาไม่ได้ในกราฟและ legend ด้านบน (${unpriced.map((r) => r.ticker).join(', ')}) — ดูรายละเอียดได้ในตารางด้านล่าง`;
      unpricedNote.style.display = 'block';
    } else {
      unpricedNote.style.display = 'none';
    }

    if (rows.length === 0) {
      document.getElementById('alloc-donut').innerHTML = '';
      document.getElementById('alloc-legend').innerHTML = '';
      document.getElementById('alloc-total').textContent = '';
      body.innerHTML = '<tr><td colspan="9" class="empty">ยังไม่มีโพซิชันที่เปิดอยู่</td></tr>';
      return;
    }

    setupToggles();
    renderView();
    renderTable(rows);
  } catch (e) {
    body.innerHTML = '<tr><td colspan="9" class="empty">โหลดข้อมูลไม่สำเร็จ: ' + escapeHtml(e.message) + '</td></tr>';
    AppUI.setDataStatus('อัปเดตข้อมูลไม่สำเร็จ', 'error');
  }
}

render();
