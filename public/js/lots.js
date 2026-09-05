// แตกเลดเจอร์เป็น "ล็อต" รายไม้ด้วยวิธี FIFO (ซื้อก่อน-ขายก่อน)
//
// ต่างจาก holdings.js ที่ยุบทุกครั้งที่ซื้อเป็นต้นทุนเฉลี่ยก้อนเดียว - ที่นี่การซื้อ
// แต่ละครั้งอยู่แยกกัน จึงตอบได้ว่า "ไม้ที่ซื้อวันนั้น" กำไรหรือขาดทุนเท่าไหร่ และ
// ถ้าเอาเงินก้อนเดียวกันไปซื้อดัชนีในวันเดียวกันจะดีกว่าหรือแย่กว่า
//
// ข้อตกลงเรื่องต้นทุน/ค่าธรรมเนียม (ให้ตรงกับ holdings.js เป๊ะ ๆ เพื่อไม่ให้สอง
// หน้าแสดงตัวเลขขัดกันเอง):
//   - ค่าธรรมเนียมซื้อ  บวกเข้าต้นทุนของล็อตนั้น
//   - ค่าธรรมเนียมขาย   หักออกจากเงินที่ได้รับ และเฉลี่ยตามจำนวนหน่วยเมื่อการขาย
//                       ครั้งเดียวกินหลายล็อต
//   - transfer in  = ซื้อ (สร้างล็อตใหม่)
//   - transfer out = เอาของออกโดยไม่มีกำไรขาดทุน (ตัดหน่วยที่ต้นทุนของมันเอง)
const Lots = (() => {
  const EPS = 1e-9;

  function daysBetween(fromISO, toISO) {
    return Math.max(0, Math.round(
      (new Date(toISO + 'T00:00:00Z') - new Date(fromISO + 'T00:00:00Z')) / 86400000,
    ));
  }

  // คืน { lots, unmatched } โดย unmatched = จำนวนหน่วยที่มีรายการขายแต่หาไม้ซื้อ
  // รองรับไม่เจอ (ซื้อไว้ก่อนเริ่มบันทึก) - ไม่ปัดทิ้งเงียบ ๆ เพราะมันแปลว่า
  // กำไรที่คำนวณได้ของ ticker นั้นไม่ครบ และหน้าจอต้องเตือนผู้ใช้
  function build(transactions) {
    const sorted = [...transactions].sort((a, b) => (
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0
    ));

    const openByTicker = new Map(); // ticker -> ล็อตที่ยังมีหน่วยเหลือ (เรียงเก่า->ใหม่)
    const lots = [];
    let unmatched = 0;

    for (const tx of sorted) {
      const action = (tx.action || '').toLowerCase();
      const qty = Number(tx.shares) || 0;
      const price = Number(tx.price) || 0;
      const commission = Number(tx.commission) || 0;
      if (qty <= EPS) continue;
      if (!openByTicker.has(tx.ticker)) openByTicker.set(tx.ticker, []);
      const queue = openByTicker.get(tx.ticker);

      if (action === 'buy' || action === 'transfer in') {
        const lot = {
          id: tx.id || `${tx.ticker}-${tx.date}-${lots.length}`,
          ticker: tx.ticker,
          openDate: tx.date,
          shares: qty,
          sharesRemaining: qty,
          // ค่าธรรมเนียมซื้อเกลี่ยลงราคาต่อหน่วย ทำให้ทุกตัวเลข % ด้านล่าง
          // คิดจากเงินที่จ่ายจริง ไม่ใช่ราคาหน้าจอตอนกดซื้อ
          unitCost: qty > EPS ? (qty * price + commission) / qty : 0,
          rawPrice: price,
          currency: tx.origCurrency || tx.currency || 'USD',
          costBasis: qty * price + commission,
          realizedGain: 0,
          proceeds: 0,
          sharesSold: 0,
          sells: [],
          closeDate: null,
        };
        lots.push(lot);
        queue.push(lot);
        continue;
      }

      if (action !== 'sell' && action !== 'transfer out') continue;

      // ค่าธรรมเนียมขายเฉลี่ยตามหน่วย เพราะการขายครั้งเดียวอาจกินหลายล็อต
      const feePerShare = qty > EPS ? commission / qty : 0;
      let left = qty;
      while (left > EPS && queue.length > 0) {
        const lot = queue[0];
        const take = Math.min(left, lot.sharesRemaining);
        if (action === 'sell') {
          const gross = take * price;
          const fee = take * feePerShare;
          lot.proceeds += gross - fee;
          lot.realizedGain += gross - fee - take * lot.unitCost;
          lot.sells.push({ date: tx.date, shares: take, price, fee });
        } else {
          // transfer out: ของออกจากพอร์ตโดยไม่มีกำไรขาดทุน คิดที่ต้นทุนของมันเอง
          lot.proceeds += take * lot.unitCost;
          lot.sells.push({ date: tx.date, shares: take, price: lot.unitCost, fee: 0, isTransfer: true });
        }
        lot.sharesSold += take;
        lot.sharesRemaining -= take;
        left -= take;
        if (lot.sharesRemaining <= EPS) {
          lot.sharesRemaining = 0;
          lot.closeDate = tx.date;
          queue.shift();
        }
      }
      if (left > EPS) unmatched += left;
    }

    return { lots, unmatched };
  }

  // เติมราคาปัจจุบัน + ผลตอบแทนของดัชนีในช่วงที่ถือ ลงในแต่ละล็อต
  //
  // priceMap  : { TICKER: {price} } แบบเดียวกับที่ Prices.fetchFor คืนมา (normalize เป็น USD แล้ว)
  // benchAt   : (dateISO) => ราคาปิดดัชนีวันนั้น (forward-fill แล้ว) หรือ null ถ้าไม่มีดัชนี
  // todayISO  : วันที่ใช้เป็น "วันนี้" สำหรับล็อตที่ยังถืออยู่
  function enrich(lots, priceMap, benchAt, todayISO) {
    return lots.map((lot) => {
      const p = priceMap[lot.ticker];
      const price = p && !p.error && typeof p.price === 'number' ? p.price : null;
      const costRemaining = lot.sharesRemaining * lot.unitCost;
      const marketValue = lot.sharesRemaining > EPS && price !== null ? lot.sharesRemaining * price : null;

      // ล็อตที่ยังถืออยู่แต่ดึงราคาไม่ได้ = ประเมินผลตอบแทนไม่ได้ ต้องเป็น null
      // ไม่ใช่ 0 มิฉะนั้นมันจะถูกนับเป็น "ล็อตที่แพ้" ในอัตราชนะ
      const priceable = lot.sharesRemaining <= EPS || marketValue !== null;
      const totalGain = priceable ? lot.realizedGain + ((marketValue || 0) - costRemaining) : null;
      const totalReturn = priceable && lot.costBasis > EPS ? totalGain / lot.costBasis : null;

      const endDate = lot.closeDate || todayISO;
      const holdingDays = daysBetween(lot.openDate, endDate);

      let benchReturn = null;
      if (benchAt) {
        const openClose = benchAt(lot.openDate);
        const endClose = benchAt(endDate);
        if (openClose > EPS && endClose != null) benchReturn = endClose / openClose - 1;
      }
      const alpha = totalReturn !== null && benchReturn !== null ? totalReturn - benchReturn : null;

      const status = lot.sharesRemaining <= EPS ? 'closed'
        : lot.sharesSold > EPS ? 'partial' : 'open';

      return {
        ...lot, price, costRemaining, marketValue, totalGain, totalReturn,
        benchReturn, alpha, holdingDays, endDate, status,
      };
    });
  }

  function summarize(enrichedLots) {
    const scored = enrichedLots.filter((l) => l.totalReturn !== null);
    const wins = scored.filter((l) => l.totalGain > 0).length;
    const withAlpha = scored.filter((l) => l.alpha !== null);
    const alphaWins = withAlpha.filter((l) => l.alpha > 0).length;
    return {
      total: enrichedLots.length,
      scored: scored.length,
      closed: enrichedLots.filter((l) => l.status === 'closed').length,
      wins,
      losses: scored.length - wins,
      winRate: scored.length ? (wins / scored.length) * 100 : null,
      alphaScored: withAlpha.length,
      alphaWins,
      alphaLosses: withAlpha.length - alphaWins,
      alphaWinRate: withAlpha.length ? (alphaWins / withAlpha.length) * 100 : null,
      totalGain: scored.reduce((s, l) => s + l.totalGain, 0),
      // ผลตอบแทนถ่วงน้ำหนักด้วยเงินที่ลงในแต่ละล็อต - ล็อต 100 บาทที่ +50% ไม่ควร
      // มีน้ำหนักเท่าล็อต 10,000 บาทที่ -5% เวลาสรุปภาพรวม
      totalCost: scored.reduce((s, l) => s + l.costBasis, 0),
    };
  }

  // สรุปกิจกรรมซื้อขายรายปีจากเลดเจอร์ดิบ (ไม่ผ่านล็อต) - ใช้ตอบว่าปีไหนเทรดหนัก
  // และค่าธรรมเนียมกินไปเท่าไหร่
  function activityByYear(transactions) {
    const byYear = new Map();
    for (const tx of transactions) {
      const action = (tx.action || '').toLowerCase();
      if (action !== 'buy' && action !== 'sell') continue;
      const year = String(tx.date).slice(0, 4);
      if (!byYear.has(year)) {
        byYear.set(year, { year, buys: 0, sells: 0, buyValue: 0, sellValue: 0, fees: 0 });
      }
      const row = byYear.get(year);
      const value = (Number(tx.shares) || 0) * (Number(tx.price) || 0);
      row.fees += Number(tx.commission) || 0;
      if (action === 'buy') { row.buys++; row.buyValue += value; } else { row.sells++; row.sellValue += value; }
    }
    return [...byYear.values()]
      .map((r) => ({
        ...r,
        tradeValue: r.buyValue + r.sellValue,
        feePct: r.buyValue + r.sellValue > EPS ? (r.fees / (r.buyValue + r.sellValue)) * 100 : null,
      }))
      .sort((a, b) => b.year.localeCompare(a.year));
  }

  return { build, enrich, summarize, activityByYear, daysBetween };
})();
