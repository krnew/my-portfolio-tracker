// หน้าวิเคราะห์การเทรด: แตกทุกไม้เป็นล็อต FIFO แล้วให้คะแนนทีละไม้ เทียบกับดัชนี
// ในช่วงวันที่ถือไม้นั้นพอดี (Alpha)
//
// ใช้ benchmark ตัวแรกที่เลือกไว้ในหน้าผลตอบแทนร่วมกัน (localStorage 'perf.benchmarks')
// เพื่อไม่ให้สองหน้าเทียบคนละดัชนีแล้วสรุปขัดกันเอง
(function () {
  const BENCH_KEY = 'perf.benchmarks';
  const FLAG_BUY = '#2a78d6';
  const FLAG_SELL = '#eb6834';

  function loadBenchmark() {
    try {
      const raw = localStorage.getItem(BENCH_KEY);
      if (raw === null) return 'SPY';
      const arr = JSON.parse(raw);
      return Array.isArray(arr) && arr.length && typeof arr[0] === 'string' ? arr[0].toUpperCase() : null;
    } catch (e) {
      return 'SPY';
    }
  }

  async function fetchHistory(tickers, start) {
    const res = await fetch('/api/history?tickers=' + encodeURIComponent(tickers.join(','))
      + '&start=' + encodeURIComponent(start));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // ค่าปิดที่ carry forward มาถึงวันที่ขอ - วันหยุด/วันที่ตลาดปิดจะได้ค่าของวันทำการ
  // ก่อนหน้า และวันที่เก่ากว่าจุดเริ่มของ series จะได้ค่าแรกสุด (เหมือน
  // Currency.rateOnDate) ดีกว่าคืน null แล้วทำให้ Alpha หายไปทั้งแถว
  function makeLookup(series) {
    if (!Array.isArray(series) || series.length === 0) return null;
    const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date));
    return (date) => {
      let close = sorted[0].close;
      for (const pt of sorted) {
        if (pt.date > date) break;
        close = pt.close;
      }
      return close;
    };
  }

  const fmtGain = (n) => (n === null ? '-' : fmtMoney(n));
  const fmtRet = (n) => (n === null ? '-' : fmtPct(n * 100));

  // ---------------------------------------------------------------------
  // กราฟดัชนี + ธงซื้อ/ขาย: เห็นว่าเราเข้าออกตรงจังหวะไหนของตลาด
  // ---------------------------------------------------------------------
  function renderFlagChart(series, events, benchLabel) {
    const svg = document.getElementById('flag-svg');
    const wrap = document.getElementById('flag-wrap');
    const empty = document.getElementById('flag-empty');
    if (!series || series.length < 2) {
      svg.innerHTML = '';
      empty.style.display = 'block';
      empty.textContent = 'ไม่มีข้อมูลราคาย้อนหลังของดัชนีสำหรับวาดกราฟ';
      return;
    }
    empty.style.display = 'none';

    const width = wrap.clientWidth || 800;
    const height = 260;
    const pad = { top: 16, right: 16, bottom: 26, left: 56 };
    const plotW = Math.max(10, width - pad.left - pad.right);
    const plotH = height - pad.top - pad.bottom;

    const closes = series.map((p) => p.close);
    const minV = Math.min(...closes);
    const maxV = Math.max(...closes);
    const span = (maxV - minV) || maxV || 1;
    const yMin = minV - span * 0.08;
    const yMax = maxV + span * 0.08;

    const idxByDate = new Map(series.map((p, i) => [p.date, i]));
    const x = (i) => pad.left + (series.length <= 1 ? 0 : (i / (series.length - 1)) * plotW);
    const y = (v) => pad.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

    const path = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.close).toFixed(1)}`).join(' ');

    const gridlines = [];
    for (let i = 0; i <= 3; i++) {
      const v = yMin + (i / 3) * (yMax - yMin);
      const yy = y(v);
      gridlines.push(`<line x1="${pad.left}" y1="${yy.toFixed(1)}" x2="${(pad.left + plotW).toFixed(1)}" y2="${yy.toFixed(1)}" stroke="#ebe6df" stroke-width="1" />`);
      gridlines.push(`<text x="${pad.left - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end" style="font-size:11px; fill:#8e8b82;">${v.toFixed(0)}</text>`);
    }

    const xTicks = [];
    const tickCount = Math.min(5, series.length);
    for (let i = 0; i < tickCount; i++) {
      const idx = Math.round((i / (tickCount - 1 || 1)) * (series.length - 1));
      const label = new Date(series[idx].date + 'T00:00:00Z')
        .toLocaleDateString('th-TH', { month: 'short', year: '2-digit', timeZone: 'UTC' });
      xTicks.push(`<text x="${x(idx).toFixed(1)}" y="${height - 6}" text-anchor="middle" style="font-size:11px; fill:#8e8b82;">${escapeHtml(label)}</text>`);
    }

    // ธงหลายอันในวันเดียวกันจะซ้อนทับกันจนอ่านไม่ออก - รวมเป็นธงเดียวแล้วบอกใน
    // tooltip ว่าวันนั้นมีกี่รายการ
    const byDate = new Map();
    events.forEach((e) => {
      if (!idxByDate.has(e.date)) return; // วันที่ตลาดดัชนีปิด - ข้ามไป ไม่มีจุดให้ปัก
      if (!byDate.has(e.date)) byDate.set(e.date, []);
      byDate.get(e.date).push(e);
    });

    const flags = [...byDate.entries()].map(([date, list]) => {
      const i = idxByDate.get(date);
      const hasBuy = list.some((e) => e.side === 'buy');
      const color = hasBuy ? FLAG_BUY : FLAG_SELL;
      const letter = hasBuy ? 'ซ' : 'ข';
      const cy = y(series[i].close);
      const label = list.map((e) => `${e.side === 'buy' ? 'ซื้อ' : 'ขาย'} ${e.ticker} ${fmtShares(e.shares)} @ ${fmtMoney(e.price)}`).join('\n');
      return `<g><circle cx="${x(i).toFixed(1)}" cy="${(cy - 14).toFixed(1)}" r="9" fill="${color}" opacity="0.92" />`
        + `<text x="${x(i).toFixed(1)}" y="${(cy - 10).toFixed(1)}" text-anchor="middle" style="font-size:10px; font-weight:600; fill:#ffffff;">${letter}</text>`
        + `<title>${escapeHtml(date + '\n' + label)}</title></g>`;
    }).join('');

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.innerHTML = gridlines.join('') + xTicks.join('')
      + `<path d="${path}" fill="none" stroke="#6c6a64" stroke-width="1.6" />`
      + flags;
    document.getElementById('flag-title').textContent = 'จังหวะซื้อขายบนเส้น ' + benchLabel;
  }

  // ---------------------------------------------------------------------
  function renderLots(lots) {
    const body = document.getElementById('lot-body');
    if (lots.length === 0) {
      body.innerHTML = '<tr><td colspan="11" class="empty">ไม่มีล็อตที่ตรงกับตัวกรอง</td></tr>';
      return;
    }
    const statusLabel = { open: 'ยังถือ', partial: 'ขายบางส่วน', closed: 'ปิดแล้ว' };
    body.innerHTML = lots.map((l) => {
      const soldPct = l.shares > 0 ? ((l.shares - l.sharesRemaining) / l.shares) * 100 : 0;
      return `
      <tr>
        <td><strong>${escapeHtml(l.ticker)}</strong></td>
        <td><span class="lot-tag is-${l.status}">${statusLabel[l.status]}</span></td>
        <td>${escapeHtml(l.openDate)}</td>
        <td class="num">${fmtMoney(l.unitCost)}</td>
        <td class="num">
          ${fmtShares(l.sharesRemaining)} / ${fmtShares(l.shares)}
          <span class="lot-bar"><span style="width:${soldPct.toFixed(1)}%"></span></span>
        </td>
        <td class="num">${fmtMoney(l.costBasis)}</td>
        <td class="num ${l.totalGain === null ? '' : signClass(l.totalGain)}">${fmtGain(l.totalGain)}</td>
        <td class="num ${l.totalReturn === null ? '' : signClass(l.totalReturn)}">${fmtRet(l.totalReturn)}</td>
        <td class="num ${l.benchReturn === null ? '' : signClass(l.benchReturn)}">${fmtRet(l.benchReturn)}</td>
        <td class="num ${l.alpha === null ? '' : signClass(l.alpha)}"><strong>${fmtRet(l.alpha)}</strong></td>
        <td class="num">${l.holdingDays}</td>
      </tr>`;
    }).join('');
  }

  function renderActivity(rows) {
    const body = document.getElementById('activity-body');
    if (rows.length === 0) {
      body.innerHTML = '<tr><td colspan="7" class="empty">ยังไม่มีรายการซื้อขาย</td></tr>';
      return;
    }
    body.innerHTML = rows.map((r) => `
      <tr>
        <td><strong>${escapeHtml(r.year)}</strong></td>
        <td class="num">${r.buys}</td>
        <td class="num">${r.sells}</td>
        <td class="num">${fmtMoney(r.buyValue)}</td>
        <td class="num">${fmtMoney(r.sellValue)}</td>
        <td class="num">${fmtMoney(r.fees)}</td>
        <td class="num">${r.feePct === null ? '-' : r.feePct.toFixed(2) + '%'}</td>
      </tr>`).join('');
  }

  // ---------------------------------------------------------------------
  let allLots = [];

  function applyFilters() {
    const status = document.getElementById('filter-status').value;
    const result = document.getElementById('filter-result').value;
    const ticker = document.getElementById('filter-ticker').value;
    const sort = document.getElementById('filter-sort').value;

    let rows = allLots.filter((l) => {
      if (status === 'holding' && l.status === 'closed') return false;
      if (status === 'closed' && l.status !== 'closed') return false;
      if (result === 'win' && !(l.totalGain > 0)) return false;
      if (result === 'loss' && !(l.totalGain < 0)) return false;
      if (result === 'beat' && !(l.alpha > 0)) return false;
      if (result === 'lag' && !(l.alpha < 0)) return false;
      if (ticker && l.ticker !== ticker) return false;
      return true;
    });

    // ค่า null (ล็อตที่ดึงราคาไม่ได้) ไปท้ายตารางเสมอ ไม่ว่าจะเรียงจากมากไปน้อย
    // หรือน้อยไปมาก - มันไม่ใช่ "ค่าน้อยที่สุด" มันคือ "ยังไม่รู้"
    const desc = (key) => (a, b) => {
      const av = a[key]; const bv = b[key];
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv - av;
    };
    if (sort === 'return') rows.sort(desc('totalReturn'));
    else if (sort === 'alpha') rows.sort(desc('alpha'));
    else if (sort === 'gain') rows.sort(desc('totalGain'));
    else if (sort === 'days') rows.sort(desc('holdingDays'));
    else rows.sort((a, b) => b.openDate.localeCompare(a.openDate));

    renderLots(rows);
    document.getElementById('lot-count').textContent = `แสดง ${rows.length} จาก ${allLots.length} ล็อต`;
  }

  function renderSummary(s, benchLabel) {
    setTile('tile-lots', 'tile-lots-sub', String(s.total),
      s.closed ? `ปิดไปแล้ว ${s.closed} ล็อต` : 'ยังไม่มีล็อตที่ปิด');

    setTile('tile-winrate', 'tile-winrate-sub',
      s.winRate === null ? '-' : s.winRate.toFixed(1) + '%',
      s.scored ? `ชนะ ${s.wins} · แพ้ ${s.losses}` : '');

    setTile('tile-alpha-winrate', 'tile-alpha-winrate-sub',
      s.alphaWinRate === null ? '-' : s.alphaWinRate.toFixed(1) + '%',
      s.alphaScored ? `ชนะ ${s.alphaWins} · แพ้ ${s.alphaLosses} (เทียบ ${benchLabel})` : 'ไม่มีดัชนีให้เทียบ');

    const weighted = s.totalCost > 0 ? (s.totalGain / s.totalCost) * 100 : null;
    setTile('tile-trade-gain', 'tile-trade-gain-sub', fmtMoney(s.totalGain),
      weighted === null ? '' : `คิดเป็น ${fmtPct(weighted)} ของเงินที่ลงไป`,
      signClass(s.totalGain));
  }

  async function init() {
    const lotBody = document.getElementById('lot-body');
    try {
      const { transactions, droppedCount } = await Currency.normalizeTransactions(await Api.list());
      if (transactions.length === 0) {
        lotBody.innerHTML = '<tr><td colspan="11" class="empty">ยังไม่มีธุรกรรม — เพิ่มรายการแรกได้ที่หน้ารายการธุรกรรม</td></tr>';
        AppUI.setDataStatus('ยังไม่มีธุรกรรมสำหรับวิเคราะห์', 'ready');
        return;
      }

      const { lots, unmatched } = Lots.build(transactions);
      const tickers = [...new Set(transactions.map((t) => t.ticker))];
      const earliest = transactions.reduce((min, t) => (t.date < min ? t.date : min), transactions[0].date);
      const todayStr = todayLocalISO();
      const benchTicker = loadBenchmark();

      const openTickers = [...new Set(lots.filter((l) => l.sharesRemaining > 1e-9).map((l) => l.ticker))];
      // ดึงราคาของ benchmark มาด้วย ไม่ใช่เพื่อแสดงผล แต่เพื่อให้รู้สกุลเงินของมัน
      // (จาก meta ของ Yahoo) ก่อนตัดสินใจว่าต้องแปลงประวัติราคาเป็น USD หรือไม่ -
      // ถ้าไม่ดึง ดัชนีต่างสกุล เช่น ^SET.BK จะถูกคิดเป็น USD ไปเงียบ ๆ แล้ว Alpha
      // จะเพี้ยนเพราะฝั่งผลตอบแทนของล็อตแปลงเป็น USD ไปแล้ว
      const priceTickers = [...new Set(benchTicker ? [...openTickers, benchTicker] : openTickers)];
      const [liveData, benchHistory] = await Promise.all([
        Prices.fetchFor(priceTickers),
        benchTicker ? fetchHistory([benchTicker], earliest).catch(() => ({})) : Promise.resolve({}),
      ]);
      AppUI.updatePriceStatus(liveData.prices, liveData.fx);
      const prices = Currency.normalizePrices(liveData.prices, liveData.fx);

      // ดัชนีที่ไม่ได้อยู่ในสกุล USD ต้องแปลงก่อน ไม่งั้น Alpha จะรวมผลของอัตรา
      // แลกเปลี่ยนเข้าไปด้วย ทั้งที่ผลตอบแทนของล็อตถูกแปลงเป็น USD ไปแล้ว
      let benchSeries = benchTicker && Array.isArray(benchHistory[benchTicker]) ? benchHistory[benchTicker] : null;
      let benchNote = '';
      if (!benchTicker) {
        benchNote = 'ยังไม่ได้เลือกดัชนีเปรียบเทียบ — เลือกได้ที่หน้าผลตอบแทน แล้วกลับมาหน้านี้จะคำนวณให้อัตโนมัติ';
      } else if (!benchSeries) {
        benchNote = `ดึงข้อมูลย้อนหลังของ ${benchTicker} ไม่สำเร็จ คอลัมน์เทียบดัชนีจึงว่างไว้ก่อน`;
      } else {
        const benchLive = liveData.prices && liveData.prices[benchTicker];
        const benchCcy = (benchLive && !benchLive.error && benchLive.currency) || 'USD';
        if (benchCcy !== 'USD') {
          benchSeries = await Currency.normalizeHistorySeries(benchSeries, benchCcy);
          if (!benchSeries.length) {
            benchSeries = null;
            benchNote = `${benchTicker} อยู่ในสกุล ${benchCcy} ซึ่งแปลงเป็น USD ไม่สำเร็จ`;
          }
        }
      }

      const benchLabel = benchTicker || 'ดัชนี';
      const benchAt = makeLookup(benchSeries);
      allLots = Lots.enrich(lots, prices, benchAt, todayStr);

      renderSummary(Lots.summarize(allLots), benchLabel);

      document.getElementById('bench-name').textContent = benchLabel;
      document.querySelectorAll('[data-bench-label]').forEach((el) => { el.textContent = benchLabel; });

      const warnings = [];
      if (droppedCount > 0) warnings.push(`ไม่รวม ${droppedCount} ธุรกรรมที่แปลงสกุลเงินเป็น USD ไม่ได้`);
      if (unmatched > 1e-9) warnings.push(`มีรายการขาย ${fmtShares(unmatched)} หน่วยที่หาไม้ซื้อคู่กันไม่เจอ (น่าจะซื้อไว้ก่อนเริ่มบันทึก) กำไรของส่วนนี้จึงไม่ถูกนับ`);
      if (benchNote) warnings.push(benchNote);
      const warnEl = document.getElementById('trade-warning');
      warnEl.innerHTML = warnings.map(escapeHtml).join('<br>');
      warnEl.style.display = warnings.length ? 'block' : 'none';

      document.getElementById('filter-ticker').innerHTML = '<option value="">ทุก ticker</option>'
        + tickers.sort().map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');

      ['filter-status', 'filter-result', 'filter-ticker', 'filter-sort'].forEach((id) => {
        document.getElementById(id).addEventListener('change', applyFilters);
      });
      applyFilters();

      renderActivity(Lots.activityByYear(transactions));

      const events = transactions
        .filter((t) => ['buy', 'sell'].includes((t.action || '').toLowerCase()))
        .map((t) => ({ date: t.date, side: (t.action || '').toLowerCase(), ticker: t.ticker, shares: Number(t.shares) || 0, price: Number(t.price) || 0 }));
      renderFlagChart(benchSeries, events, benchLabel);
      let resizeTimer = null;
      new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => renderFlagChart(benchSeries, events, benchLabel), 120);
      }).observe(document.getElementById('flag-wrap'));
    } catch (e) {
      lotBody.innerHTML = '<tr><td colspan="11" class="empty">โหลดข้อมูลไม่สำเร็จ: ' + escapeHtml(e.message) + '</td></tr>';
      AppUI.setDataStatus('วิเคราะห์การเทรดไม่สำเร็จ', 'error');
    }
  }

  init();
})();
