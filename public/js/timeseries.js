// Daily portfolio valuation, TWR, XIRR (MWR), and a parallel "what if this
// money went into SPY instead" simulation. Pure functions, verified against
// hand-computed cases before being wired into any page.
const TimeSeries = (() => {
  function buildCalendar(historyMap, tickers) {
    const set = new Set();
    tickers.forEach((t) => (historyMap[t] || []).forEach((pt) => set.add(pt.date)));
    return [...set].sort();
  }

  function forwardFill(series, calendar) {
    const map = new Map((series || []).map((p) => [p.date, p.close]));
    let last = null;
    return calendar.map((d) => {
      if (map.has(d)) last = map.get(d);
      return last;
    });
  }

  // A ticker's own transactions, chronological, with sell/transfer-out quantities
  // clamped to whatever was actually held at the time - same rule Holdings.compute
  // uses. Without this, a sell that exceeds the recorded position (e.g. shares
  // bought before the ledger's start date) drives the running position negative,
  // which then SUBTRACTS phantom value from the whole portfolio every day after.
  // investorCashFlow follows the XIRR sign convention (buy = money leaving the
  // investor's pocket = negative; sell = money received = positive).
  function buildClampedEvents(transactions, ticker) {
    const events = transactions
      .filter((t) => t.ticker === ticker)
      .slice()
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    let shares = 0;
    return events.map((e) => {
      const action = (e.action || '').toLowerCase();
      const qty = Number(e.shares) || 0;
      const price = Number(e.price) || 0;
      const commission = Number(e.commission) || 0;
      let investorCashFlow = 0;
      if (action === 'buy' || action === 'transfer in') {
        shares += qty;
        investorCashFlow = -(qty * price + commission);
      } else if (action === 'sell' || action === 'transfer out') {
        const sellQty = Math.min(qty, shares);
        shares -= sellQty;
        investorCashFlow = sellQty * price - commission;
      }
      return { date: e.date, action, investorCashFlow, sharesAfter: shares };
    });
  }

  // Running shares-held per day for one ticker, from the transaction ledger.
  function buildSharesTimeline(transactions, ticker, calendar) {
    const events = buildClampedEvents(transactions, ticker);
    let idx = 0, shares = 0;
    return calendar.map((d) => {
      while (idx < events.length && events[idx].date <= d) { shares = events[idx].sharesAfter; idx++; }
      return shares;
    });
  }

  // Net $ contributed (buys) minus withdrawn (sells) per calendar day, across ALL
  // tickers - using the same clamped quantities as buildSharesTimeline, so a
  // phantom oversell never shows up as free cash appearing from nowhere either.
  function dailyCashFlow(transactions, calendar) {
    const tickers = [...new Set(transactions.map((t) => t.ticker))];
    const byDate = new Map();
    tickers.forEach((ticker) => {
      buildClampedEvents(transactions, ticker).forEach((e) => {
        byDate.set(e.date, (byDate.get(e.date) || 0) - e.investorCashFlow);
      });
    });
    return calendar.map((d) => byDate.get(d) || 0);
  }

  function dailyIncome(transactions, calendar) {
    const byDate = new Map();
    transactions.forEach((t) => {
      if ((t.action || '').toLowerCase() !== 'dividend') return;
      const net = Math.max(0, (Number(t.amount) || 0) - (Number(t.tax) || 0));
      byDate.set(t.date, (byDate.get(t.date) || 0) + net);
    });
    return calendar.map((d) => byDate.get(d) || 0);
  }

  // Modified-Dietz-style daily TWR: strip today's net contribution/withdrawal
  // out of today's ending value before comparing to yesterday's, so a flow's
  // size never leaks into the measured return.
  function dailyTWR(values, cashFlows, incomeFlows) {
    const returns = new Array(values.length).fill(0);
    for (let i = 1; i < values.length; i++) {
      const prev = values[i - 1];
      const income = incomeFlows ? (incomeFlows[i] || 0) : 0;
      returns[i] = prev > 1e-9 ? (values[i] + income - cashFlows[i]) / prev - 1 : 0;
    }
    return returns;
  }

  // Plain price-return series (no cash-flow adjustment) - for a benchmark index.
  function dailyPriceReturn(closes) {
    const returns = new Array(closes.length).fill(0);
    for (let i = 1; i < closes.length; i++) {
      const prev = closes[i - 1];
      returns[i] = prev > 1e-9 && closes[i] != null ? closes[i] / prev - 1 : 0;
    }
    return returns;
  }

  function linkReturns(dailyReturns, fromIdx, toIdx) {
    let acc = 1;
    for (let i = Math.max(fromIdx, 1); i <= toIdx; i++) acc *= (1 + dailyReturns[i]);
    return acc - 1;
  }

  function annualize(totalReturn, days) {
    if (days <= 0) return 0;
    return Math.pow(1 + totalReturn, 365 / days) - 1;
  }

  function xirr(cashflows) {
    if (cashflows.length < 2) return 0;
    const t0 = new Date(cashflows[0].date + 'T00:00:00Z').getTime();
    const years = cashflows.map((c) => (new Date(c.date + 'T00:00:00Z').getTime() - t0) / (365 * 86400000));
    const npv = (r) => cashflows.reduce((s, c, i) => s + c.amount / Math.pow(1 + r, years[i]), 0);
    const dnpv = (r) => cashflows.reduce((s, c, i) => s - (years[i] * c.amount) / Math.pow(1 + r, years[i] + 1), 0);

    let r = 0.1;
    for (let iter = 0; iter < 100; iter++) {
      const f = npv(r);
      const d = dnpv(r);
      if (Math.abs(d) < 1e-12) break;
      const next = r - f / d;
      if (!Number.isFinite(next)) break;
      if (Math.abs(next - r) < 1e-9) { r = next; break; }
      r = Math.max(-0.999, next);
    }
    if (!Number.isFinite(r) || Math.abs(npv(r)) > 1) {
      let lo = -0.99, hi = 10, flo = npv(lo), fhi = npv(hi);
      if (flo * fhi <= 0) {
        for (let i = 0; i < 200; i++) {
          const mid = (lo + hi) / 2, fm = npv(mid);
          if (Math.abs(fm) < 1e-6) { r = mid; break; }
          if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
          r = mid;
        }
      }
    }
    return r;
  }

  // Parallel hypothetical portfolio: every net contribution/withdrawal is
  // applied to SPY instead, using that day's close as the fill price.
  function simulateBenchmark(cashFlows, benchmarkCloses) {
    let shares = 0;
    return cashFlows.map((cf, i) => {
      const price = benchmarkCloses[i];
      if (price > 1e-9) shares += cf / price;
      return shares * (price || 0);
    });
  }

  function addMonths(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + n);
    return d.toISOString().slice(0, 10);
  }

  function startOfYear(dateStr) {
    return dateStr.slice(0, 4) + '-01-01';
  }

  // First calendar index whose date is >= sinceDate (for "return over the last N months").
  function indexFrom(calendar, sinceDate) {
    for (let i = 0; i < calendar.length; i++) {
      if (calendar[i] >= sinceDate) return i;
    }
    return calendar.length - 1;
  }

  function bucketKey(dateStr, granularity) {
    if (granularity === 'year') return dateStr.slice(0, 4);
    if (granularity === 'quarter') {
      const m = Number(dateStr.slice(5, 7));
      return dateStr.slice(0, 4) + '-Q' + (Math.floor((m - 1) / 3) + 1);
    }
    return dateStr.slice(0, 7); // month
  }

  function bucketReturns(calendar, dailyReturns, granularity) {
    const buckets = [];
    let curKey = null, fromIdx = null;
    for (let i = 0; i < calendar.length; i++) {
      const k = bucketKey(calendar[i], granularity);
      if (k !== curKey) {
        if (curKey !== null) buckets.push({ key: curKey, fromIdx, toIdx: i - 1 });
        curKey = k; fromIdx = i;
      }
    }
    if (curKey !== null) buckets.push({ key: curKey, fromIdx, toIdx: calendar.length - 1 });
    return buckets.map((b) => ({ key: b.key, return: linkReturns(dailyReturns, b.fromIdx, b.toIdx) }));
  }

  // ---------------------------------------------------------------------
  // สถิติความเสี่ยง - คิดจาก dailyReturns (ผลตอบแทนรายวันแบบ TWR) ไม่ใช่จาก
  // values โดยตรง เพราะ values จะกระโดดทุกครั้งที่เติมเงิน ซึ่งไม่ใช่การขาดทุน
  // จริง ถ้าเอา values ไปคิด drawdown ตรง ๆ วันที่ถอนเงินออกจะกลายเป็น "ร่วง"
  // ทั้งที่พอร์ตไม่ได้เสียหายอะไรเลย
  // ---------------------------------------------------------------------

  // เส้นมูลค่าสมมติที่เริ่มจาก 1 แล้วเดินตามผลตอบแทนรายวันล้วน ๆ (ไม่มีเงินเข้าออก)
  function equityCurve(dailyReturns) {
    let v = 1;
    return dailyReturns.map((r) => {
      if (Number.isFinite(r)) v *= (1 + r);
      return v;
    });
  }

  // % ที่ต่ำกว่าจุดสูงสุดเดิม ณ แต่ละวัน (0 = กำลังทำจุดสูงสุดใหม่, -0.2 = ต่ำกว่ายอด 20%)
  function drawdownSeries(dailyReturns) {
    const curve = equityCurve(dailyReturns);
    let peak = -Infinity;
    return curve.map((v) => {
      if (v > peak) peak = v;
      return peak > 0 ? v / peak - 1 : 0;
    });
  }

  // จุดที่จมลึกที่สุด + ช่วงที่จมนานที่สุด (นับเป็นวันตามปฏิทิน ไม่ใช่วันทำการ
  // เพราะสิ่งที่ผู้ใช้อยากรู้คือ "ต้องรอนานแค่ไหน" ไม่ใช่ "ตลาดเปิดกี่วัน")
  //
  // ช่วงที่ยังไม่ฟื้นจนถึงวันสุดท้ายก็นับด้วย - ไม่งั้นพอร์ตที่กำลังจมอยู่ตอนนี้
  // จะรายงาน "จมนานสุด" เป็นครั้งเก่าที่ฟื้นแล้ว ทั้งที่ครั้งปัจจุบันยาวกว่า
  function drawdownStats(dailyReturns, calendar) {
    const dd = drawdownSeries(dailyReturns);
    let maxDD = 0;
    let maxIdx = -1;
    dd.forEach((v, i) => { if (v < maxDD) { maxDD = v; maxIdx = i; } });

    let longestDays = 0;
    let startIdx = null;
    for (let i = 0; i < dd.length; i++) {
      if (dd[i] < -1e-9) {
        if (startIdx === null) startIdx = i;
      } else if (startIdx !== null) {
        longestDays = Math.max(longestDays, daysBetween(calendar[startIdx], calendar[i]));
        startIdx = null;
      }
    }
    if (startIdx !== null) {
      longestDays = Math.max(longestDays, daysBetween(calendar[startIdx], calendar[calendar.length - 1]));
    }

    // จุดที่ผลตอบแทนสะสมเคยขึ้นไปสูงสุด - ต้องมาจากเส้นเดียวกับ drawdown เป๊ะ ๆ
    // ไม่งั้นการ์ดจะขัดกันเอง (เช่นบอกว่ายอดสูงสุดคือวันนี้ แต่ก็บอกว่าตอนนี้
    // ต่ำกว่ายอด 15% ไปพร้อมกัน) ซึ่งจะเกิดขึ้นถ้าเอายอดเงินจริงมาปนกับตัวเลข
    // ที่คิดจากผลตอบแทนล้วน
    const curve = equityCurve(dailyReturns);
    let peakIdx = 0;
    curve.forEach((v, i) => { if (v > curve[peakIdx]) peakIdx = i; });

    return {
      series: dd,
      current: dd.length ? dd[dd.length - 1] : 0,
      max: maxDD,
      maxDate: maxIdx >= 0 ? calendar[maxIdx] : null,
      peakReturn: curve.length ? curve[peakIdx] - 1 : 0,
      peakDate: calendar[peakIdx],
      longestDays,
      recovered: startIdx === null,
    };
  }

  function daysBetween(fromISO, toISO) {
    return Math.max(0, Math.round(
      (new Date(toISO + 'T00:00:00Z') - new Date(fromISO + 'T00:00:00Z')) / 86400000,
    ));
  }

  // ความผันผวนต่อปี: ส่วนเบี่ยงเบนมาตรฐานของผลตอบแทนรายวัน คูณ sqrt(252)
  // (252 = จำนวนวันทำการโดยประมาณใน 1 ปี ซึ่งเป็นค่ามาตรฐานของวงการ)
  //
  // ข้ามวันแรก (index 0) เสมอ เพราะ dailyTWR กำหนดให้เป็น 0 ตายตัว ไม่ใช่
  // ผลตอบแทนจริง - ถ้านับรวมจะดึงค่าเฉลี่ยและ SD ให้เพี้ยนลง
  function volatility(dailyReturns) {
    const r = dailyReturns.slice(1).filter(Number.isFinite);
    if (r.length < 2) return null;
    const mean = r.reduce((s, v) => s + v, 0) / r.length;
    const variance = r.reduce((s, v) => s + (v - mean) ** 2, 0) / (r.length - 1);
    return Math.sqrt(variance) * Math.sqrt(252);
  }

  // Sharpe = (ผลตอบแทนต่อปี - ผลตอบแทนไร้ความเสี่ยง) / ความผันผวนต่อปี
  // riskFree ปล่อยเป็น 0 ได้ถ้าไม่อยากตั้งสมมติฐาน (ค่าจะสูงกว่าความจริงเล็กน้อย)
  function sharpe(dailyReturns, riskFree = 0) {
    const vol = volatility(dailyReturns);
    if (!vol || vol < 1e-9) return null;
    const r = dailyReturns.slice(1).filter(Number.isFinite);
    if (r.length < 2) return null;
    const mean = r.reduce((s, v) => s + v, 0) / r.length;
    return (mean * 252 - riskFree) / vol;
  }

  // Beta = ความแปรปรวนร่วมของพอร์ตกับดัชนี หารด้วยความแปรปรวนของดัชนี
  function beta(dailyReturns, benchReturns) {
    const n = Math.min(dailyReturns.length, benchReturns.length);
    const pairs = [];
    for (let i = 1; i < n; i++) {
      if (Number.isFinite(dailyReturns[i]) && Number.isFinite(benchReturns[i])) {
        pairs.push([dailyReturns[i], benchReturns[i]]);
      }
    }
    if (pairs.length < 2) return null;
    const meanP = pairs.reduce((s, p) => s + p[0], 0) / pairs.length;
    const meanB = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
    const cov = pairs.reduce((s, p) => s + (p[0] - meanP) * (p[1] - meanB), 0) / (pairs.length - 1);
    const varB = pairs.reduce((s, p) => s + (p[1] - meanB) ** 2, 0) / (pairs.length - 1);
    return varB > 1e-12 ? cov / varB : null;
  }

  return {
    buildCalendar, forwardFill, buildClampedEvents, buildSharesTimeline, dailyCashFlow, dailyIncome,
    dailyTWR, dailyPriceReturn, linkReturns, annualize, xirr, simulateBenchmark,
    addMonths, startOfYear, indexFrom, bucketReturns,
    equityCurve, drawdownSeries, drawdownStats, volatility, sharpe, beta, daysBetween,
  };
})();
