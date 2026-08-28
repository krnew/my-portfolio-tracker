async function render() {
  const body = document.getElementById('holdings-body');
  try {
    const { transactions, droppedCount } = await Currency.normalizeTransactions(await Api.list());
    const holdings = Holdings.compute(transactions);
    const openTickers = holdings.filter((h) => h.shares > 1e-9).map((h) => h.ticker);

    let priceData = { prices: {}, fx: null };
    try {
      priceData = await Prices.fetchFor(openTickers);
    } catch (e) {
      // price service unreachable - fall back to cost-basis-only view below
    }
    priceData.prices = Currency.normalizePrices(priceData.prices, priceData.fx);

    const fxWarningEl = document.getElementById('fx-warning');
    if (droppedCount > 0) {
      fxWarningEl.textContent = `⚠️ ไม่รวม ${droppedCount} ธุรกรรมที่แปลงสกุลเงินเป็น USD ไม่ได้ (เน็ตล่มตอนโหลด) — ยอดพอร์ตด้านล่างจึงอาจน้อยกว่าความจริง ลองรีเฟรชอีกครั้ง`;
      fxWarningEl.style.display = 'block';
    } else {
      fxWarningEl.style.display = 'none';
    }

    const p = Portfolio.enrich(holdings, priceData.prices);

    setTile('tile-value', 'tile-value-sub', fmtMoney(p.totalMarketValue),
      priceData.fx ? fmtBaht(p.totalMarketValue * priceData.fx.rate) : '');
    setTile('tile-today', null, fmtMoney(p.totalDayChange) + '  ' + fmtPct(p.totalDayChangePct), null, signClass(p.totalDayChange));
    setTile('tile-unrealized', null, fmtMoney(p.totalUnrealizedGain), null, signClass(p.totalUnrealizedGain));
    setTile('tile-realized', null, fmtMoney(p.totalRealizedPL), null, signClass(p.totalRealizedPL));

    const oversold = p.rows.filter((r) => r.oversoldShares > 1e-9);
    const warningEl = document.getElementById('oversold-warning');
    if (oversold.length > 0) {
      const detail = oversold.map((r) => `${escapeHtml(r.ticker)} (ขายเกิน ${fmtShares(r.oversoldShares)} หุ้น)`).join(', ');
      warningEl.textContent = `⚠️ พบรายการขายมากกว่าที่ซื้อไว้ในระบบ: ${detail} — แปลว่าอาจมีหุ้นที่ซื้อไว้ก่อนเริ่มบันทึกในนี้ ตัวเลข avg cost/realized P&L ของ ticker เหล่านี้จึงไม่ครบถ้วน แก้ไขได้ที่หน้า Transactions`;
      warningEl.style.display = 'block';
    } else {
      warningEl.style.display = 'none';
    }

    if (p.rows.length === 0) {
      body.innerHTML = '<tr><td colspan="8" class="empty">ยังไม่มีธุรกรรม — ไปที่หน้า Transactions เพื่อเพิ่ม</td></tr>';
    } else {
      body.innerHTML = p.rows.map((r) => {
        const isOpen = r.shares > 1e-9;
        const lastCell = !isOpen ? '-' : (r.price !== null ? fmtMoney(r.price) : 'N/A');
        const mvCell = !isOpen ? '-' : (r.marketValue !== null ? fmtMoney(r.marketValue) : 'N/A');
        const unrCell = !isOpen ? '-' : (r.unrealizedGain !== null ? fmtMoney(r.unrealizedGain) : 'N/A');
        const dayCell = !isOpen ? '-' : (r.dayChange !== null ? fmtMoney(r.dayChange) : 'N/A');
        const oversoldFlag = r.oversoldShares > 1e-9 ? ' <span title="มีการขายมากกว่าที่ซื้อไว้ในระบบ - ตัวเลขนี้อาจไม่ครบ">⚠️</span>' : '';
        return `
        <tr>
          <td><strong>${escapeHtml(r.ticker)}</strong>${oversoldFlag}${r.stale ? ' <span title="ราคาช้า อาจไม่ใช่ล่าสุด">⚠️</span>' : ''}</td>
          <td>${fmtShares(r.shares)}</td>
          <td>${fmtMoney(r.avgCost)}</td>
          <td>${lastCell}</td>
          <td>${mvCell}</td>
          <td class="${isOpen && r.unrealizedGain !== null ? signClass(r.unrealizedGain) : ''}">${unrCell}</td>
          <td class="${isOpen && r.dayChange !== null ? signClass(r.dayChange) : ''}">${dayCell}</td>
          <td class="${signClass(r.realizedPL)}">${fmtMoney(r.realizedPL)}</td>
        </tr>
      `;
      }).join('');
    }
  } catch (e) {
    body.innerHTML = '<tr><td colspan="8" class="empty">โหลดข้อมูลไม่สำเร็จ: ' + escapeHtml(e.message) + '</td></tr>';
  }
}

render();
