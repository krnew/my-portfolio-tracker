const PORTFOLIO_COLOR = '#2a78d6';
const BENCHMARK_COLOR = '#eb6834';

async function fetchHistory(tickers, start) {
  const qs = encodeURIComponent(tickers.join(','));
  const res = await fetch('/api/history?tickers=' + qs + '&start=' + encodeURIComponent(start));
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function fmtMoneyShort(n) {
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.round(Math.abs(n)).toLocaleString();
}

function heatBg(pct) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return '';
  const alpha = Math.min(Math.abs(pct) * 4, 0.35);
  const rgb = pct >= 0 ? '26,158,107' : '224,71,63';
  return `background: rgba(${rgb},${alpha});`;
}

function fmtCell(v) {
  if (v === null || v === undefined) return '<td><span style="color:var(--text-dim)">-</span></td>';
  return `<td><span class="${signClass(v)}">${fmtPct(v * 100)}</span></td>`;
}

// Holds everything the hover handler needs for the CURRENTLY rendered chart.
// Read fresh on every mousemove instead of captured in a per-render closure,
// so a resize (which calls renderChart again) can't leave stale listeners
// stacked on top of each other - see the single addEventListener below.
let chartState = null;

// The full, never-sliced series computed once by render(). chartState above
// only ever holds whatever was last passed to renderChart, so once a range
// button slices it once, chartState is no longer safe to re-slice from -
// fullChartData is written exactly once and only ever read by range clicks.
let fullChartData = null;

function computeChartGeometry(calendar, portfolioValues, benchmarkValues, containerWidth) {
  const width = containerWidth || 800;
  const height = 280;
  const padding = { top: 14, right: 16, bottom: 26, left: 64 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const n = calendar.length;

  const allVals = portfolioValues.concat(benchmarkValues).filter((v) => Number.isFinite(v));
  const minV = Math.min(...allVals);
  const maxV = Math.max(...allVals);
  const pad = (maxV - minV) * 0.08 || maxV * 0.08 || 1;
  const yMin = minV - pad;
  const yMax = maxV + pad;

  const x = (i) => padding.left + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const y = (v) => padding.top + plotH - ((v - yMin) / ((yMax - yMin) || 1)) * plotH;

  return { width, height, padding, plotW, plotH, n, yMin, yMax, x, y };
}

function renderChart(calendar, portfolioValues, benchmarkValues) {
  const svg = document.getElementById('chart-svg');
  const wrap = document.getElementById('chart-wrap');
  const geo = computeChartGeometry(calendar, portfolioValues, benchmarkValues, wrap.clientWidth);
  const { width, height, padding, plotW, plotH, n, yMin, yMax, x, y } = geo;
  chartState = { calendar, portfolioValues, benchmarkValues, geo };

  function pathFor(series) {
    let d = '';
    for (let i = 0; i < series.length; i++) {
      const v = series[i];
      if (!Number.isFinite(v)) continue;
      d += (d ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1) + ' ';
    }
    return d.trim();
  }

  let gridSvg = '';
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = yMin + (i / ticks) * (yMax - yMin);
    const yy = y(v);
    gridSvg += `<line x1="${padding.left}" y1="${yy.toFixed(1)}" x2="${width - padding.right}" y2="${yy.toFixed(1)}" class="chart-gridline" />`;
    gridSvg += `<text x="${padding.left - 8}" y="${(yy + 3).toFixed(1)}" text-anchor="end" class="chart-axis-label">${fmtMoneyShort(v)}</text>`;
  }

  let xLabelsSvg = '';
  const xTickCount = Math.min(5, n);
  for (let i = 0; i < xTickCount; i++) {
    const idx = Math.round((i / (xTickCount - 1 || 1)) * (n - 1));
    const d = new Date(calendar[idx] + 'T00:00:00Z');
    const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    xLabelsSvg += `<text x="${x(idx).toFixed(1)}" y="${height - 6}" text-anchor="middle" class="chart-axis-label">${label}</text>`;
  }

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.innerHTML = `${gridSvg}${xLabelsSvg}
    <path d="${pathFor(benchmarkValues)}" fill="none" stroke="${BENCHMARK_COLOR}" stroke-width="2" />
    <path d="${pathFor(portfolioValues)}" fill="none" stroke="${PORTFOLIO_COLOR}" stroke-width="2" />
    <line id="crosshair" x1="0" y1="${padding.top}" x2="0" y2="${padding.top + plotH}" stroke="#c3c2b7" stroke-width="1" style="display:none" />`;
}

function handleChartMove(clientX) {
  if (!chartState) return;
  const svg = document.getElementById('chart-svg');
  const tooltip = document.getElementById('chart-tooltip');
  const crosshair = document.getElementById('crosshair');
  if (!crosshair) return;
  const { calendar, portfolioValues, benchmarkValues, geo } = chartState;

  const rect = svg.getBoundingClientRect();
  // The SVG's rendered size follows its container (width:100%) but the
  // viewBox coordinate system stays fixed at the size captured when it was
  // last drawn - convert screen px back to viewBox units by that ratio, or
  // the crosshair drifts further from the pointer the more the two diverge
  // (measured: 308px off at 1400px wide, -115px off at 380px wide).
  const scale = rect.width / geo.width;
  const vbX = (clientX - rect.left) / scale;
  const rel = (vbX - geo.padding.left) / geo.plotW;
  const idx = Math.max(0, Math.min(geo.n - 1, Math.round(rel * (geo.n - 1))));

  crosshair.setAttribute('x1', geo.x(idx));
  crosshair.setAttribute('x2', geo.x(idx));
  crosshair.style.display = 'block';

  const d = new Date(calendar[idx] + 'T00:00:00Z');
  const dateLabel = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

  tooltip.innerHTML = '';
  const dateDiv = document.createElement('div');
  dateDiv.className = 'date';
  dateDiv.textContent = dateLabel;
  tooltip.appendChild(dateDiv);

  [['My Portfolio', PORTFOLIO_COLOR, portfolioValues[idx]], ['If S&P500', BENCHMARK_COLOR, benchmarkValues[idx]]].forEach(([label, color, val]) => {
    const row = document.createElement('div');
    row.className = 'row';
    const key = document.createElement('span');
    key.className = 'key';
    key.style.background = color;
    const name = document.createElement('span');
    name.textContent = label;
    const value = document.createElement('span');
    value.className = 'val';
    value.textContent = fmtMoney(val);
    row.appendChild(key);
    row.appendChild(name);
    row.appendChild(value);
    tooltip.appendChild(row);
  });

  const pointScreenX = geo.x(idx) * scale;
  const tw = tooltip.offsetWidth || 160;
  let left = pointScreenX + 14;
  if (left + tw > rect.width) left = pointScreenX - tw - 14;
  tooltip.style.left = left + 'px';
  tooltip.style.top = '8px';
  tooltip.style.display = 'block';
}

function handleChartLeave() {
  document.getElementById('chart-tooltip').style.display = 'none';
  const crosshair = document.getElementById('crosshair');
  if (crosshair) crosshair.style.display = 'none';
}

document.getElementById('chart-svg').addEventListener('mousemove', (e) => handleChartMove(e.clientX));
document.getElementById('chart-svg').addEventListener('mouseleave', handleChartLeave);

// Re-draw (not just re-scale) on container resize, so the chart keeps a 1:1
// viewBox-to-pixel ratio at every width instead of drifting the way the SVG's
// own automatic scaling would.
let chartResizeTimer = null;
new ResizeObserver(() => {
  if (!chartState) return;
  clearTimeout(chartResizeTimer);
  chartResizeTimer = setTimeout(() => {
    renderChart(chartState.calendar, chartState.portfolioValues, chartState.benchmarkValues);
  }, 120);
}).observe(document.getElementById('chart-wrap'));

function renderChartTable(calendar, portfolioValues, benchmarkValues) {
  const body = document.getElementById('chart-table-body');
  body.innerHTML = calendar.map((d, i) => `
    <tr><td>${d}</td><td>${fmtMoney(portfolioValues[i])}</td><td>${fmtMoney(benchmarkValues[i])}</td></tr>
  `).join('');
}

// Slices the FULL series down to the requested window and re-renders both
// the chart and its "view as table" twin from that same slice, so the two
// always agree regardless of which is currently visible. Ranges longer than
// the available history (e.g. "5Y" on an 11-month-old portfolio) clamp to
// the full range for free via TimeSeries.indexFrom's own clamp-to-0 behavior.
function applyChartRange(rangeKey) {
  if (!fullChartData) return;
  const { calendar, values, benchmarkValues } = fullChartData;
  const todayStr = todayLocalISO();
  let since;
  switch (rangeKey) {
    case '1m': since = TimeSeries.addMonths(todayStr, -1); break;
    case '3m': since = TimeSeries.addMonths(todayStr, -3); break;
    case '6m': since = TimeSeries.addMonths(todayStr, -6); break;
    case 'ytd': since = TimeSeries.startOfYear(todayStr); break;
    case '1y': since = TimeSeries.addMonths(todayStr, -12); break;
    case '3y': since = TimeSeries.addMonths(todayStr, -36); break;
    case '5y': since = TimeSeries.addMonths(todayStr, -60); break;
    default: since = calendar[0]; break; // 'all' and any unrecognized key
  }
  const startIdx = TimeSeries.indexFrom(calendar, since);
  const c = calendar.slice(startIdx);
  const v = values.slice(startIdx);
  const b = benchmarkValues.slice(startIdx);
  renderChart(c, v, b);
  renderChartTable(c, v, b);
}

function renderHeatmap(calendar, portReturns, spyReturns, granularity) {
  const body = document.getElementById('heatmap-body');
  const portBuckets = TimeSeries.bucketReturns(calendar, portReturns, granularity);
  const spyBuckets = TimeSeries.bucketReturns(calendar, spyReturns, granularity);
  const rows = portBuckets.map((b, i) => {
    const spy = spyBuckets[i] ? spyBuckets[i].return : null;
    const diff = spy === null ? null : b.return - spy;
    return { key: b.key, port: b.return, spy, diff };
  }).slice().reverse();

  body.innerHTML = rows.map((r) => `
    <tr>
      <td><strong>${r.key}</strong></td>
      <td style="${heatBg(r.port)}">${fmtPct(r.port * 100)}</td>
      <td style="${heatBg(r.spy)}">${fmtPct(r.spy * 100)}</td>
      <td style="${heatBg(r.diff)}">${r.diff === null ? '-' : fmtPct(r.diff * 100)}</td>
    </tr>
  `).join('');
}

async function render() {
  const periodBody = document.getElementById('period-body');
  const heatmapBody = document.getElementById('heatmap-body');
  try {
    const { transactions } = await Currency.normalizeTransactions(await Api.list());
    if (transactions.length === 0) {
      periodBody.innerHTML = '<tr><td colspan="8" class="empty">ยังไม่มีธุรกรรม</td></tr>';
      heatmapBody.innerHTML = '<tr><td colspan="4" class="empty">ยังไม่มีธุรกรรม</td></tr>';
      return;
    }

    const allTickers = [...new Set(transactions.map((t) => t.ticker))];
    const earliestDate = transactions.reduce((min, t) => (t.date < min ? t.date : min), transactions[0].date);
    const todayStr = todayLocalISO();

    const holdings = Holdings.compute(transactions);
    const openTickers = holdings.filter((h) => h.shares > 1e-9).map((h) => h.ticker);

    const [historyMap, liveData] = await Promise.all([
      fetchHistory([...allTickers, 'SPY'], earliestDate),
      Prices.fetchFor([...openTickers, 'SPY']),
    ]);

    // GOLD-THB is the only pseudo-ticker whose native currency is known
    // client-side; its history/live price come back raw THB from the server
    // (same as any THB-quoted Yahoo ticker would) and need converting per-day
    // before they're used in any valuation math below.
    if (Array.isArray(historyMap['GOLD-THB'])) {
      historyMap['GOLD-THB'] = await Currency.normalizeHistorySeries(historyMap['GOLD-THB'], 'THB');
    }
    liveData.prices = Currency.normalizePrices(liveData.prices, liveData.fx);

    let calendar = TimeSeries.buildCalendar(historyMap, [...allTickers, 'SPY']);
    if (calendar.length === 0) throw new Error('ไม่มีข้อมูลราคาย้อนหลัง');
    if (calendar[calendar.length - 1] !== todayStr) calendar = [...calendar, todayStr];
    const lastIdx = calendar.length - 1;

    const closesByTicker = {};
    allTickers.forEach((t) => {
      closesByTicker[t] = TimeSeries.forwardFill(Array.isArray(historyMap[t]) ? historyMap[t] : [], calendar);
    });
    const spyCloses = TimeSeries.forwardFill(Array.isArray(historyMap.SPY) ? historyMap.SPY : [], calendar);

    const sharesByTicker = {};
    allTickers.forEach((t) => {
      sharesByTicker[t] = TimeSeries.buildSharesTimeline(transactions, t, calendar);
    });

    const values = calendar.map((_, i) => allTickers.reduce((s, t) => {
      const price = closesByTicker[t][i];
      const sh = sharesByTicker[t][i];
      return s + (price != null && sh ? sh * price : 0);
    }, 0));

    // Keep "today" consistent with the live quotes Home/Allocation already show,
    // since Yahoo's daily history bar for an in-progress trading day lags behind.
    const livePortfolio = Portfolio.enrich(holdings, liveData.prices || {});
    if (calendar[lastIdx] === todayStr) values[lastIdx] = livePortfolio.totalMarketValue;
    const liveSpy = liveData.prices && liveData.prices.SPY;
    if (calendar[lastIdx] === todayStr && liveSpy && typeof liveSpy.price === 'number') {
      spyCloses[lastIdx] = liveSpy.price;
    }

    const cashFlows = TimeSeries.dailyCashFlow(transactions, calendar);
    const dailyTWR = TimeSeries.dailyTWR(values, cashFlows);
    const spyDailyReturn = TimeSeries.dailyPriceReturn(spyCloses);
    const benchmarkValues = TimeSeries.simulateBenchmark(cashFlows, spyCloses);

    const totalTWR = TimeSeries.linkReturns(dailyTWR, 1, lastIdx);
    const totalSpy = TimeSeries.linkReturns(spyDailyReturn, 1, lastIdx);
    document.getElementById('tile-value').textContent = fmtMoney(values[lastIdx]);
    const twrTile = document.getElementById('tile-twr');
    twrTile.textContent = fmtPct(totalTWR * 100);
    twrTile.className = 'value ' + signClass(totalTWR);

    const xirrCashflows = allTickers
      .flatMap((t) => TimeSeries.buildClampedEvents(transactions, t))
      .filter((e) => e.investorCashFlow !== 0)
      .map((e) => ({ date: e.date, amount: e.investorCashFlow }))
      .concat([{ date: todayStr, amount: values[lastIdx] }])
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const mwr = TimeSeries.xirr(xirrCashflows);
    const mwrTile = document.getElementById('tile-mwr');
    mwrTile.textContent = fmtPct(mwr * 100);
    mwrTile.className = 'value ' + signClass(mwr);

    const vsSpy = totalTWR - totalSpy;
    const vsSpyTile = document.getElementById('tile-vs-spy');
    vsSpyTile.textContent = fmtPct(vsSpy * 100);
    vsSpyTile.className = 'value ' + signClass(vsSpy);

    const periods = [
      { label: '1M', since: TimeSeries.addMonths(todayStr, -1) },
      { label: '3M', since: TimeSeries.addMonths(todayStr, -3) },
      { label: '6M', since: TimeSeries.addMonths(todayStr, -6) },
      { label: 'YTD', since: TimeSeries.startOfYear(todayStr) },
      { label: '1Y', since: TimeSeries.addMonths(todayStr, -12) },
      { label: 'All', since: calendar[0] },
    ];
    const daysElapsedAll = (new Date(calendar[lastIdx] + 'T00:00:00Z') - new Date(calendar[0] + 'T00:00:00Z')) / 86400000;

    function rowFor(seriesReturns) {
      return periods.map((p) => {
        if (p.since < calendar[0]) return null;
        const idx = TimeSeries.indexFrom(calendar, p.since);
        return TimeSeries.linkReturns(seriesReturns, idx, lastIdx);
      });
    }
    const portRow = rowFor(dailyTWR);
    const spyRow = rowFor(spyDailyReturn);
    const portAnnualized = TimeSeries.annualize(portRow[portRow.length - 1], daysElapsedAll);
    const spyAnnualized = TimeSeries.annualize(spyRow[spyRow.length - 1], daysElapsedAll);

    periodBody.innerHTML = `
      <tr><td><strong>My Portfolio</strong></td>${portRow.map(fmtCell).join('')}${fmtCell(portAnnualized)}</tr>
      <tr><td>S&amp;P500</td>${spyRow.map(fmtCell).join('')}${fmtCell(spyAnnualized)}</tr>
      <tr><td style="color:var(--text-dim)">vs S&amp;P500</td>${portRow.map((v, i) => fmtCell(v === null || spyRow[i] === null ? null : v - spyRow[i])).join('')}${fmtCell(portAnnualized - spyAnnualized)}</tr>
    `;

    fullChartData = { calendar, values, benchmarkValues };
    applyChartRange('all');

    renderHeatmap(calendar, dailyTWR, spyDailyReturn, 'month');
    document.querySelectorAll('#granularity-toggle button').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#granularity-toggle button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        renderHeatmap(calendar, dailyTWR, spyDailyReturn, btn.dataset.g);
      });
    });
  } catch (e) {
    periodBody.innerHTML = '<tr><td colspan="8" class="empty">โหลดข้อมูลไม่สำเร็จ: ' + escapeHtml(e.message) + '</td></tr>';
    heatmapBody.innerHTML = '<tr><td colspan="4" class="empty">-</td></tr>';
  }
}

document.querySelectorAll('#chart-range-toggle button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#chart-range-toggle button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    applyChartRange(btn.dataset.range);
  });
});

document.getElementById('toggle-chart-table').addEventListener('click', () => {
  const tableWrap = document.getElementById('chart-table-wrap');
  const chartWrap = document.getElementById('chart-wrap');
  const btn = document.getElementById('toggle-chart-table');
  const showingTable = tableWrap.style.display !== 'none';
  tableWrap.style.display = showingTable ? 'none' : 'block';
  chartWrap.style.display = showingTable ? 'block' : 'none';
  btn.textContent = showingTable ? 'แสดงเป็นตาราง' : 'แสดงเป็นกราฟ';
});

render();
