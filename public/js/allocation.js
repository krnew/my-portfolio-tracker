// Categorical palette validated via the dataviz skill's validate_palette.js
// (adjacent-pair CVD safe, fixed hue order - never reassign per filter/sort).
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const OTHER_COLOR = '#898781';
const MAX_SLOTS = 8;

// Folds anything past the first (MAX_SLOTS - 1) rows into a single "Other" bucket,
// since a generated 9th hue would be indistinguishable from an existing one under CVD.
function withColorsAndOther(rows) {
  if (rows.length <= MAX_SLOTS) {
    return rows.map((r, i) => ({ ...r, color: PALETTE[i], label: r.ticker }));
  }
  const head = rows.slice(0, MAX_SLOTS - 1).map((r, i) => ({ ...r, color: PALETTE[i], label: r.ticker }));
  const tail = rows.slice(MAX_SLOTS - 1);
  const other = {
    label: `Other (${tail.length})`,
    color: OTHER_COLOR,
    marketValue: tail.reduce((s, r) => s + (r.marketValue || 0), 0),
    allocationPct: tail.reduce((s, r) => s + r.allocationPct, 0),
    unrealizedGain: tail.reduce((s, r) => s + (r.unrealizedGain || 0), 0),
    isOther: true,
  };
  return [...head, other];
}

// Donut via the stroke-dasharray-on-a-circle idiom: each segment is a ring
// slice, rotated -90deg so the first segment starts at 12 o'clock. External
// leader-line labels (ticker + %) only for segments >=8% - small slices stay
// readable via the legend below instead of crowding the chart.
function renderDonut(colored) {
  const svg = document.getElementById('alloc-donut');
  const total = colored.reduce((s, r) => s + r.allocationPct, 0) || 1;
  const cx = 200, cy = 140, r = 75, strokeWidth = 35, labelR = r + 25;
  const circumference = 2 * Math.PI * r;

  let cumulativePct = 0;
  const arcs = [];
  const labels = [];

  colored.forEach((seg) => {
    const pct = seg.allocationPct;
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
      labels.push(`<line x1="${lx1.toFixed(1)}" y1="${ly1.toFixed(1)}" x2="${lx2.toFixed(1)}" y2="${ly2.toFixed(1)}" stroke="#c3c2b7" stroke-width="1" />`);
      labels.push(`<text x="${tx.toFixed(1)}" y="${ly2.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle" style="font-size:12px; font-weight:600; fill:#1f2233;">${escapeHtml(seg.label)}: ${pct.toFixed(1)}%</text>`);
    }
    cumulativePct += pct;
  });

  svg.innerHTML = arcs.join('') + labels.join('');
}

async function render() {
  const body = document.getElementById('alloc-body');
  const donutSvg = document.getElementById('alloc-donut');
  const legend = document.getElementById('alloc-legend');

  try {
    const { transactions, droppedCount } = await Currency.normalizeTransactions(await Api.list());
    const holdings = Holdings.compute(transactions);
    const openTickers = holdings.filter((h) => h.shares > 1e-9).map((h) => h.ticker);

    let priceData = { prices: {}, fx: null };
    try { priceData = await Prices.fetchFor(openTickers); } catch (e) { /* fall back below */ }
    priceData.prices = Currency.normalizePrices(priceData.prices, priceData.fx);

    const fxWarningEl = document.getElementById('alloc-fx-warning');
    if (droppedCount > 0) {
      fxWarningEl.textContent = `⚠️ ไม่รวม ${droppedCount} ธุรกรรมที่แปลงสกุลเงินเป็น USD ไม่ได้ (เน็ตล่มตอนโหลด)`;
      fxWarningEl.style.display = 'block';
    } else {
      fxWarningEl.style.display = 'none';
    }

    const p = Portfolio.enrich(holdings, priceData.prices);
    const rows = p.rows.filter((r) => r.shares > 1e-9);
    const priced = rows.filter((r) => r.marketValue !== null);
    const unpriced = rows.filter((r) => r.marketValue === null);

    setTile('tile-value', 'tile-value-sub', fmtMoney(p.totalMarketValue),
      priceData.fx ? fmtBaht(p.totalMarketValue * priceData.fx.rate) : '');
    setTile('tile-count', null, String(rows.length));
    setTile('tile-unrealized', null, fmtMoney(p.totalUnrealizedGain), null, signClass(p.totalUnrealizedGain));

    const unpricedNote = document.getElementById('alloc-unpriced-note');
    if (unpriced.length > 0) {
      unpricedNote.textContent = `ไม่รวม ${unpriced.length} รายการที่ดึงราคาไม่ได้ในกราฟและ legend ด้านบน (${unpriced.map((r) => r.ticker).join(', ')}) — ดูรายละเอียดได้ในตารางด้านล่าง`;
      unpricedNote.style.display = 'block';
    } else {
      unpricedNote.style.display = 'none';
    }

    if (rows.length === 0) {
      donutSvg.innerHTML = '';
      legend.innerHTML = '';
      body.innerHTML = '<tr><td colspan="7" class="empty">ยังไม่มีโพซิชันที่เปิดอยู่</td></tr>';
      return;
    }

    if (priced.length === 0) {
      donutSvg.innerHTML = '';
      legend.innerHTML = '<div class="item" style="color:var(--text-dim)">ดึงราคาไม่ได้ทุกรายการ ดูตารางด้านล่าง</div>';
    }

    const colored = withColorsAndOther(priced);

    if (priced.length > 0) renderDonut(colored);

    legend.innerHTML = colored.map((r) => `
      <div class="item">
        <span class="swatch" style="background:${r.color}"></span>
        <span>${escapeHtml(r.label)}</span>
        <span class="pct">${r.allocationPct.toFixed(1)}%</span>
      </div>
    `).join('');

    body.innerHTML = rows.map((r) => {
      const lastCell = r.price !== null ? fmtMoney(r.price) : 'N/A';
      const mvCell = r.marketValue !== null ? fmtMoney(r.marketValue) : 'N/A';
      const unrCell = r.unrealizedGain !== null ? fmtMoney(r.unrealizedGain) : 'N/A';
      return `
        <tr>
          <td><strong>${escapeHtml(r.ticker)}</strong>${r.stale ? ' <span title="ราคาช้า อาจไม่ใช่ล่าสุด">⚠️</span>' : ''}</td>
          <td>${r.allocationPct.toFixed(1)}%</td>
          <td>${fmtShares(r.shares)}</td>
          <td>${fmtMoney(r.avgCost)}</td>
          <td>${lastCell}</td>
          <td>${mvCell}</td>
          <td class="${r.unrealizedGain !== null ? signClass(r.unrealizedGain) : ''}">${unrCell}</td>
        </tr>
      `;
    }).join('');
  } catch (e) {
    body.innerHTML = '<tr><td colspan="7" class="empty">โหลดข้อมูลไม่สำเร็จ: ' + escapeHtml(e.message) + '</td></tr>';
  }
}

render();
