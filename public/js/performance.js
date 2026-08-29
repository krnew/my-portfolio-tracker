const PORTFOLIO_COLOR = '#2a78d6';
// Same palette as allocation.js:3 (validated via the dataviz skill's
// validate_palette.js - adjacent-pair CVD safe, fixed hue order). Index 0 is
// always the portfolio; index i+1 is the i-th selected benchmark, so the
// order never depends on load-completion order (see loadedSeries() below).
const CHART_PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'];
const MAX_BENCHMARKS = 4;
const STORAGE_KEY = 'perf.benchmarks';

// Pseudo-suggestions merged into the ticker picker (see ticker-suggest.js's
// own SYNTHETIC list) for indices that either use Yahoo's caret syntax
// (nobody types "^GSPC" unprompted) or that people search for by a common
// name. Plain ETF tickers (QQQ, VOO, VT, GLD, ...) are left OUT on purpose -
// /api/search (Yahoo symbol search) already finds those just fine.
const INDEX_SUGGESTIONS = [
  { symbol: '^GSPC', name: 'S&P 500', exchange: 'Index', keywords: ['s&p', 'sp500', 's&p500'] },
  { symbol: '^NDX', name: 'Nasdaq 100', exchange: 'Index', keywords: ['nasdaq'] },
  { symbol: '^DJI', name: 'Dow Jones Industrial Average', exchange: 'Index', keywords: ['dow', 'dow jones'] },
  { symbol: '^RUT', name: 'Russell 2000', exchange: 'Index', keywords: ['russell'] },
  { symbol: '^SET.BK', name: 'SET Index (ตลาดหลักทรัพย์ไทย)', exchange: 'Index', keywords: ['set', 'เซ็ต', 'ตลาดหุ้นไทย'] },
];

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

// ---------------------------------------------------------------------------
// Selected-benchmark persistence (localStorage). This project has never used
// browser storage before, so every read/write is wrapped - a private window
// or storage-disabled browser must degrade to "default benchmark", not break
// the page. An explicitly-saved EMPTY selection (user removed every chip) is
// a valid, distinct state from "never configured" - only a genuinely missing
// key falls back to the default ['SPY'].
// ---------------------------------------------------------------------------
function loadSelected() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return ['SPY'];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return ['SPY'];
    return [...new Set(arr.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().toUpperCase()))].slice(0, MAX_BENCHMARKS);
  } catch (e) {
    return ['SPY'];
  }
}

function saveSelected() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(selected)); } catch (e) { /* storage full/disabled - selection just won't persist */ }
}

// Holds everything the hover handler needs for the CURRENTLY rendered chart.
// Read fresh on every mousemove instead of captured in a per-render closure,
// so a resize (which calls renderChart again) can't leave stale listeners
// stacked on top of each other - see the single addEventListener below.
let chartState = null;

// The full, never-sliced series computed once per renderAll() call. chartState
// above only ever holds whatever was last passed to renderChart, so once a
// range button slices it once, chartState is no longer safe to re-slice from -
// fullChartData is the one written fresh by renderAll and only ever read by
// range clicks (applyChartRange).
let fullChartData = null;

// Set once per page load by computeCore() - the portfolio's own valuation,
// completely independent of which benchmark(s) are selected. See plan issue
// #1: the calendar here is built ONLY from the portfolio's own tickers, so
// switching benchmarks can never change the portfolio's own TWR.
let coreState = null;

// ticker -> { status: 'loading' } | { status: 'ready', closes, dailyReturn, simValues } | { status: 'error', message }
// Keyed independently of `selected` so removing then re-adding a ticker never
// re-fetches - entries are mutated in place (see ensureBenchmarkLoading), so
// every reader always sees the live status even mid-flight.
let benchmarkCache = new Map();

let selected = loadSelected();
let currentRange = 'all';
let currentGranularity = 'month';

function computeChartGeometry(calendar, series, containerWidth) {
  const width = containerWidth || 800;
  const height = 280;
  const padding = { top: 14, right: 16, bottom: 26, left: 64 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const n = calendar.length;

  const allVals = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  const minV = allVals.length ? Math.min(...allVals) : 0;
  const maxV = allVals.length ? Math.max(...allVals) : 1;
  const pad = (maxV - minV) * 0.08 || maxV * 0.08 || 1;
  const yMin = minV - pad;
  const yMax = maxV + pad;

  const x = (i) => padding.left + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const y = (v) => padding.top + plotH - ((v - yMin) / ((yMax - yMin) || 1)) * plotH;

  return { width, height, padding, plotW, plotH, n, yMin, yMax, x, y };
}

// series: [{key, label, color, values}], portfolio always first (index 0).
function renderChart(calendar, series) {
  const svg = document.getElementById('chart-svg');
  const wrap = document.getElementById('chart-wrap');
  const geo = computeChartGeometry(calendar, series, wrap.clientWidth);
  const { width, height, padding, plotW, plotH, n, yMin, yMax, x, y } = geo;
  chartState = { calendar, series, geo };

  function pathFor(values) {
    let d = '';
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
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

  // Draw in reverse (last benchmark first) so index 0 - the portfolio - is
  // always painted LAST and stays on top, matching the original two-line
  // behavior regardless of how many benchmarks are in the mix.
  let pathsSvg = '';
  for (let i = series.length - 1; i >= 0; i--) {
    pathsSvg += `<path d="${pathFor(series[i].values)}" fill="none" stroke="${series[i].color}" stroke-width="2" />`;
  }

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.innerHTML = `${gridSvg}${xLabelsSvg}${pathsSvg}
    <line id="crosshair" x1="0" y1="${padding.top}" x2="0" y2="${padding.top + plotH}" stroke="#c3c2b7" stroke-width="1" style="display:none" />`;
}

function handleChartMove(clientX) {
  if (!chartState) return;
  const svg = document.getElementById('chart-svg');
  const tooltip = document.getElementById('chart-tooltip');
  const crosshair = document.getElementById('crosshair');
  if (!crosshair) return;
  const { calendar, series, geo } = chartState;

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

  series.forEach(({ label, color, values }) => {
    const row = document.createElement('div');
    row.className = 'row';
    const key = document.createElement('span');
    key.className = 'key';
    key.style.background = color;
    const name = document.createElement('span');
    name.textContent = label;
    const value = document.createElement('span');
    value.className = 'val';
    value.textContent = fmtMoney(values[idx]);
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
    renderChart(chartState.calendar, chartState.series);
  }, 120);
}).observe(document.getElementById('chart-wrap'));

function renderChartTable(calendar, series) {
  document.getElementById('chart-table-head').innerHTML =
    '<tr><th>Date</th>' + series.map((s) => `<th>${escapeHtml(s.label)}</th>`).join('') + '</tr>';
  document.getElementById('chart-table-body').innerHTML = calendar.map((d, i) => `
    <tr><td>${d}</td>${series.map((s) => `<td>${fmtMoney(s.values[i])}</td>`).join('')}</tr>
  `).join('');
}

// Slices the FULL series down to the requested window and re-renders both
// the chart and its "view as table" twin from that same slice, so the two
// always agree regardless of which is currently visible. Ranges longer than
// the available history (e.g. "5Y" on an 11-month-old portfolio) clamp to
// the full range for free via TimeSeries.indexFrom's own clamp-to-0 behavior.
function applyChartRange(rangeKey) {
  if (!fullChartData) return;
  currentRange = rangeKey; // remembered so switching benchmarks re-renders on the same range
  const { calendar, series } = fullChartData;
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
  const s = series.map((ser) => ({ ...ser, values: ser.values.slice(startIdx) }));
  renderChart(c, s);
  renderChartTable(c, s);
}

function renderLegend(series) {
  document.getElementById('chart-legend').innerHTML = series.map((s) => `
    <div class="item"><span class="line-key" style="background:${s.color}"></span> ${escapeHtml(s.label)}</div>
  `).join('');
}

// benchSeries: [{key, label, color, dailyReturn, values}] - only benchmarks
// that finished loading WITHOUT error (see renderAll). Columns grow 2-at-a-
// time per benchmark; picking exactly one benchmark reproduces the original
// fixed 3-row table exactly.
function renderPeriodTable(calendar, lastIdx, dailyTWR, benchSeries, daysElapsedAll, todayStr) {
  const periods = [
    { label: '1M', since: TimeSeries.addMonths(todayStr, -1) },
    { label: '3M', since: TimeSeries.addMonths(todayStr, -3) },
    { label: '6M', since: TimeSeries.addMonths(todayStr, -6) },
    { label: 'YTD', since: TimeSeries.startOfYear(todayStr) },
    { label: '1Y', since: TimeSeries.addMonths(todayStr, -12) },
    { label: 'All', since: calendar[0] },
  ];

  function rowFor(seriesReturns) {
    return periods.map((p) => {
      if (p.since < calendar[0]) return null;
      const idx = TimeSeries.indexFrom(calendar, p.since);
      return TimeSeries.linkReturns(seriesReturns, idx, lastIdx);
    });
  }

  const portRow = rowFor(dailyTWR);
  const portAnnualized = TimeSeries.annualize(portRow[portRow.length - 1], daysElapsedAll);

  let html = `<tr><td><strong>My Portfolio</strong></td>${portRow.map(fmtCell).join('')}${fmtCell(portAnnualized)}</tr>`;
  benchSeries.forEach((b) => {
    const row = rowFor(b.dailyReturn);
    const annualized = TimeSeries.annualize(row[row.length - 1], daysElapsedAll);
    html += `<tr><td>${escapeHtml(b.label)}</td>${row.map(fmtCell).join('')}${fmtCell(annualized)}</tr>`;
    html += `<tr><td style="color:var(--text-dim)">vs ${escapeHtml(b.label)}</td>${portRow.map((v, i) => fmtCell(v === null || row[i] === null ? null : v - row[i])).join('')}${fmtCell(portAnnualized - annualized)}</tr>`;
  });

  document.getElementById('period-body').innerHTML = html;
}

function renderHeatmap(calendar, portReturns, benchSeries, granularity) {
  document.getElementById('heatmap-head').innerHTML =
    '<tr><th>Period</th><th>My Portfolio</th>'
    + benchSeries.map((b) => `<th>${escapeHtml(b.label)}</th><th>vs ${escapeHtml(b.label)}</th>`).join('')
    + '</tr>';

  const body = document.getElementById('heatmap-body');
  const portBuckets = TimeSeries.bucketReturns(calendar, portReturns, granularity);
  const benchBucketsList = benchSeries.map((b) => TimeSeries.bucketReturns(calendar, b.dailyReturn, granularity));

  const rows = portBuckets.map((pb, i) => {
    const cells = benchBucketsList.map((buckets) => {
      const val = buckets[i] ? buckets[i].return : null;
      const diff = val === null ? null : pb.return - val;
      return { val, diff };
    });
    return { key: pb.key, port: pb.return, cells };
  }).slice().reverse();

  const colCount = 2 + benchSeries.length * 2;
  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="${colCount}" class="empty">ไม่มีข้อมูล</td></tr>`;
    return;
  }

  body.innerHTML = rows.map((r) => `
    <tr>
      <td><strong>${r.key}</strong></td>
      <td style="${heatBg(r.port)}">${fmtPct(r.port * 100)}</td>
      ${r.cells.map((c) => `<td style="${heatBg(c.val)}">${c.val === null ? '-' : fmtPct(c.val * 100)}</td><td style="${heatBg(c.diff)}">${c.diff === null ? '-' : fmtPct(c.diff * 100)}</td>`).join('')}
    </tr>
  `).join('');
}

// ---------------------------------------------------------------------------
// computeCore(): everything about the PORTFOLIO's own valuation, computed
// exactly once per page load. Never re-run when benchmarks change - see plan
// issue #2 (re-running the old render() re-attached the granularity-toggle
// listeners every time).
// ---------------------------------------------------------------------------
async function computeCore() {
  const { transactions } = await Currency.normalizeTransactions(await Api.list());
  if (transactions.length === 0) return { empty: true };

  const allTickers = [...new Set(transactions.map((t) => t.ticker))];
  const earliestDate = transactions.reduce((min, t) => (t.date < min ? t.date : min), transactions[0].date);
  const todayStr = todayLocalISO();

  const holdings = Holdings.compute(transactions);
  const openTickers = holdings.filter((h) => h.shares > 1e-9).map((h) => h.ticker);

  const [historyMap, liveData] = await Promise.all([
    fetchHistory(allTickers, earliestDate),
    Prices.fetchFor(openTickers),
  ]);

  // GOLD-THB is the only pseudo-ticker whose native currency is known
  // client-side; its history/live price come back raw THB from the server
  // (same as any THB-quoted Yahoo ticker would) and need converting per-day
  // before they're used in any valuation math below.
  if (Array.isArray(historyMap['GOLD-THB'])) {
    historyMap['GOLD-THB'] = await Currency.normalizeHistorySeries(historyMap['GOLD-THB'], 'THB');
  }
  liveData.prices = Currency.normalizePrices(liveData.prices, liveData.fx);

  // Calendar built from the PORTFOLIO'S OWN tickers only - NOT any benchmark.
  // A benchmark with a different trading calendar (a Thai index's holidays, a
  // weekend-trading crypto ticker) must never shift which days the portfolio
  // itself is valued on, or TWR would change depending on what's selected to
  // compare against. See plan issue #1.
  let calendar = TimeSeries.buildCalendar(historyMap, allTickers);
  if (calendar.length === 0) throw new Error('ไม่มีข้อมูลราคาย้อนหลัง');
  if (calendar[calendar.length - 1] !== todayStr) calendar = [...calendar, todayStr];
  const lastIdx = calendar.length - 1;

  const closesByTicker = {};
  allTickers.forEach((t) => {
    closesByTicker[t] = TimeSeries.forwardFill(Array.isArray(historyMap[t]) ? historyMap[t] : [], calendar);
  });

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

  const cashFlows = TimeSeries.dailyCashFlow(transactions, calendar);
  const dailyTWR = TimeSeries.dailyTWR(values, cashFlows);
  const totalTWR = TimeSeries.linkReturns(dailyTWR, 1, lastIdx);

  const xirrCashflows = allTickers
    .flatMap((t) => TimeSeries.buildClampedEvents(transactions, t))
    .filter((e) => e.investorCashFlow !== 0)
    .map((e) => ({ date: e.date, amount: e.investorCashFlow }))
    .concat([{ date: todayStr, amount: values[lastIdx] }])
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const mwr = TimeSeries.xirr(xirrCashflows);

  const daysElapsedAll = (new Date(calendar[lastIdx] + 'T00:00:00Z') - new Date(calendar[0] + 'T00:00:00Z')) / 86400000;

  return {
    empty: false, transactions, allTickers, earliestDate, todayStr,
    calendar, lastIdx, values, cashFlows, dailyTWR, totalTWR, mwr, daysElapsedAll,
  };
}

// Fetches + normalizes ONE benchmark ticker onto coreState.calendar. Throws
// on failure (caught by ensureBenchmarkLoading, below) rather than returning
// an error shape itself, so every failure path - bad ticker, unsupported
// currency, our own server unreachable - funnels through one place.
async function loadBenchmarkData(ticker) {
  const [historyMap, rawLiveData] = await Promise.all([
    fetchHistory([ticker], coreState.earliestDate),
    Prices.fetchFor([ticker]),
  ]);

  let series = historyMap[ticker];
  if (!Array.isArray(series)) {
    throw new Error((series && series.error) || ('ไม่พบข้อมูลราคาย้อนหลังของ ' + ticker));
  }

  const rawLivePrice = rawLiveData.prices && rawLiveData.prices[ticker];
  const nativeCurrency = (rawLivePrice && !rawLivePrice.error && rawLivePrice.currency) || 'USD';

  if (nativeCurrency !== 'USD') {
    series = await Currency.normalizeHistorySeries(series, nativeCurrency);
    if (series.length === 0) throw new Error(ticker + ' อยู่ในสกุลเงิน ' + nativeCurrency + ' ซึ่งแปลงเป็น USD ไม่สำเร็จ');
  }

  const closes = TimeSeries.forwardFill(series, coreState.calendar);

  // Same live-quote overlay computeCore() does for the portfolio itself -
  // Currency.normalizePrices only actually converts THB (everything else
  // that isn't already USD comes back as {error}), so a benchmark in some
  // other currency just keeps its last historical close for "today" instead
  // of the live tick - a quiet degradation, not a failure.
  const normalizedLive = Currency.normalizePrices(rawLiveData.prices, rawLiveData.fx)[ticker];
  if (coreState.calendar[coreState.lastIdx] === coreState.todayStr && normalizedLive && !normalizedLive.error && typeof normalizedLive.price === 'number') {
    closes[coreState.lastIdx] = normalizedLive.price;
  }

  return {
    closes,
    dailyReturn: TimeSeries.dailyPriceReturn(closes),
    simValues: TimeSeries.simulateBenchmark(coreState.cashFlows, closes),
  };
}

// Memoizing wrapper around loadBenchmarkData - see benchmarkCache's own
// comment above for why entries are mutated in place rather than replaced.
function ensureBenchmarkLoading(ticker) {
  let state = benchmarkCache.get(ticker);
  if (state) return state.promise;
  state = { status: 'loading' };
  state.promise = loadBenchmarkData(ticker)
    .then((data) => { Object.assign(state, { status: 'ready' }, data); })
    .catch((e) => { Object.assign(state, { status: 'error', message: e.message || ('โหลด ' + ticker + ' ไม่สำเร็จ') }); });
  benchmarkCache.set(ticker, state);
  return state.promise;
}

function renderChips() {
  const wrap = document.getElementById('bench-chips');
  if (selected.length === 0) {
    wrap.innerHTML = '<span class="note" style="padding:0;">ยังไม่ได้เลือก benchmark ใดๆ</span>';
    return;
  }
  wrap.innerHTML = selected.map((ticker, i) => {
    const entry = benchmarkCache.get(ticker);
    const isError = !!entry && entry.status === 'error';
    const isLoading = !entry || entry.status === 'loading';
    const color = CHART_PALETTE[(i % (CHART_PALETTE.length - 1)) + 1];
    const titleAttr = isError ? ` title="${escapeHtml(entry.message)}"` : '';
    return `
      <span class="bench-chip${isLoading ? ' loading' : ''}${isError ? ' is-error' : ''}"${titleAttr}>
        <span class="swatch" style="background:${isLoading || isError ? 'transparent' : color}"></span>
        <span class="sym">${escapeHtml(ticker)}</span>
        <button type="button" class="remove" data-ticker="${escapeHtml(ticker)}" aria-label="เอา ${escapeHtml(ticker)} ออก">×</button>
      </span>`;
  }).join('');
  wrap.querySelectorAll('.remove').forEach((btn) => {
    btn.addEventListener('click', () => setBenchmarks(selected.filter((t) => t !== btn.dataset.ticker)));
  });
}

// The one function that (re)paints everything downstream of coreState +
// benchmarkCache + selected - safe to call as often as needed (benchmark
// added/removed, granularity toggled) because it never re-fetches anything
// and never re-attaches a listener; it only reads already-settled state.
function renderAll() {
  if (!coreState || coreState.empty) return;
  const { calendar, lastIdx, values, dailyTWR, totalTWR, mwr, todayStr, daysElapsedAll } = coreState;

  document.getElementById('tile-value').textContent = fmtMoney(values[lastIdx]);
  const twrTile = document.getElementById('tile-twr');
  twrTile.textContent = fmtPct(totalTWR * 100);
  twrTile.className = 'value ' + signClass(totalTWR);
  const mwrTile = document.getElementById('tile-mwr');
  mwrTile.textContent = fmtPct(mwr * 100);
  mwrTile.className = 'value ' + signClass(mwr);

  // Only benchmarks that finished loading WITHOUT error feed the chart/tables
  // below - a failed ticker stays visible as an error chip (renderChips) but
  // must never zero out a return column or corrupt the chart's y-domain.
  const ready = selected
    .map((ticker, i) => ({ ticker, i, entry: benchmarkCache.get(ticker) }))
    .filter((b) => b.entry && b.entry.status === 'ready');

  const benchSeries = ready.map((b) => ({
    key: b.ticker,
    label: b.ticker,
    color: CHART_PALETTE[(b.i % (CHART_PALETTE.length - 1)) + 1],
    dailyReturn: b.entry.dailyReturn,
    values: b.entry.simValues,
  }));

  // The "vs Benchmark" tile always tracks the FIRST selected chip (there's
  // only one slot for it), independent of load-completion order.
  const vsLabel = document.getElementById('tile-vs-label');
  const vsTile = document.getElementById('tile-vs-bench');
  if (selected.length === 0) {
    vsLabel.textContent = 'vs Benchmark (All-time)';
    vsTile.textContent = '-';
    vsTile.className = 'value';
  } else {
    const primary = benchmarkCache.get(selected[0]);
    vsLabel.textContent = 'vs ' + selected[0] + ' (All-time)';
    if (primary && primary.status === 'ready') {
      const totalBench = TimeSeries.linkReturns(primary.dailyReturn, 1, lastIdx);
      const vs = totalTWR - totalBench;
      vsTile.textContent = fmtPct(vs * 100);
      vsTile.className = 'value ' + signClass(vs);
    } else {
      vsTile.textContent = primary && primary.status === 'error' ? 'N/A' : '...';
      vsTile.className = 'value';
    }
  }

  renderPeriodTable(calendar, lastIdx, dailyTWR, benchSeries, daysElapsedAll, todayStr);

  const chartSeries = [{ key: '__portfolio', label: 'My Portfolio', color: PORTFOLIO_COLOR, values }]
    .concat(benchSeries.map((b) => ({ key: b.key, label: b.label, color: b.color, values: b.values })));
  fullChartData = { calendar, series: chartSeries };
  renderLegend(chartSeries);
  applyChartRange(currentRange);

  renderHeatmap(calendar, dailyTWR, benchSeries, currentGranularity);
}

// Updates `selected` + localStorage, paints chips immediately (existing chips
// look right away; anything new shows the .loading state), waits for every
// selected ticker to settle (already-cached ones resolve instantly), then
// repaints chips (loading -> ready/error) and the rest of the page together.
async function setBenchmarks(list) {
  selected = [...new Set(list.map((t) => String(t).trim().toUpperCase()).filter(Boolean))].slice(0, MAX_BENCHMARKS);
  saveSelected();
  renderChips();
  await Promise.all(selected.map(ensureBenchmarkLoading));
  renderChips();
  renderAll();
}

function setupBenchmarkPicker() {
  const input = document.getElementById('bench-input');

  function tryAdd(rawTicker) {
    const ticker = String(rawTicker || '').trim().toUpperCase();
    if (!ticker || selected.includes(ticker) || selected.length >= MAX_BENCHMARKS) { input.value = ''; return; }
    input.value = '';
    setBenchmarks([...selected, ticker]);
  }

  TickerSuggest.attach(input, {
    getLocal: () => [...new Set(coreState.transactions.map((t) => t.ticker))],
    extraSuggestions: INDEX_SUGGESTIONS,
    onPick: (it) => tryAdd(it.symbol),
  });

  // TickerSuggest's own Enter handling (ticker-suggest.js onKeyDown) only
  // acts when a suggestion is actually highlighted, and in that case it has
  // already cleared input.value via pick() by the time this fires afterward
  // (listeners on the same element run in registration order) - so tryAdd()
  // here either sees '' (no-op) or the user's own free-typed text that never
  // matched a suggestion (e.g. "^N225" typed directly), which is exactly the
  // "any ticker, not just the ones in the dropdown" requirement.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') tryAdd(input.value);
  });
}

document.querySelectorAll('#chart-range-toggle button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#chart-range-toggle button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    applyChartRange(btn.dataset.range);
  });
});

document.querySelectorAll('#granularity-toggle button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#granularity-toggle button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentGranularity = btn.dataset.g;
    renderAll();
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

async function init() {
  const periodBody = document.getElementById('period-body');
  const heatmapBody = document.getElementById('heatmap-body');
  try {
    coreState = await computeCore();
  } catch (e) {
    periodBody.innerHTML = '<tr><td colspan="8" class="empty">โหลดข้อมูลไม่สำเร็จ: ' + escapeHtml(e.message) + '</td></tr>';
    heatmapBody.innerHTML = '<tr><td colspan="2" class="empty">-</td></tr>';
    return;
  }

  if (coreState.empty) {
    periodBody.innerHTML = '<tr><td colspan="8" class="empty">ยังไม่มีธุรกรรม</td></tr>';
    heatmapBody.innerHTML = '<tr><td colspan="2" class="empty">ยังไม่มีธุรกรรม</td></tr>';
    return;
  }

  setupBenchmarkPicker();
  await setBenchmarks(selected);
}

init();
