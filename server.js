const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 8787;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const CSV_PATH = path.join(DATA_DIR, 'transactions.csv');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const PRICE_CACHE_PATH = path.join(DATA_DIR, 'prices-cache.json');
const HISTORY_CACHE_PATH = path.join(DATA_DIR, 'history-cache.json');
const NEWS_CACHE_PATH = path.join(DATA_DIR, 'news-cache.json');

const PRICE_TTL_MS = 5 * 60 * 1000;
const FX_TTL_MS = 60 * 60 * 1000;
const HISTORY_TTL_MS = 12 * 60 * 60 * 1000;
const NEWS_TTL_MS = 6 * 60 * 60 * 1000; // ข่าวไม่ต้อง realtime - ผู้ใช้ยืนยันแล้วว่า "สิ้นวันเมื่อวานก็พอ"
const FETCH_TIMEOUT_MS = 8000;

const COLUMNS = ['id', 'date', 'action', 'ticker', 'price', 'currency', 'shares', 'commission', 'amount', 'tax', 'note'];
const VALID_ACTIONS = ['Buy', 'Sell', 'Transfer in', 'Transfer out', 'Dividend'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Local calendar date, NOT UTC - toISOString() runs a day behind local time
// for any timezone ahead of UTC (e.g. every morning in Thailand).
function todayLocalISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

// ---------- CSV helpers ----------
function csvEscape(value) {
  const s = value === undefined || value === null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function rowsToCsv(rows) {
  const lines = [COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(COLUMNS.map((c) => csvEscape(row[c])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function parseCsv(text) {
  const rows = [];
  let field = '', row = [], inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') pushField();
      else if (c === '\r') { /* skip, \n handles the row break */ }
      else if (c === '\n') { pushField(); pushRow(); }
      else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { pushField(); pushRow(); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function normalizeRow(obj) {
  return {
    id: obj.id || '',
    date: obj.date || '',
    action: obj.action || '',
    ticker: (obj.ticker || '').toUpperCase(),
    price: obj.price === '' || obj.price === undefined ? 0 : Number(obj.price),
    currency: obj.currency || 'USD',
    shares: obj.shares === '' || obj.shares === undefined ? 0 : Number(obj.shares),
    commission: obj.commission === '' || obj.commission === undefined ? 0 : Number(obj.commission),
    amount: obj.amount === '' || obj.amount === undefined ? 0 : Number(obj.amount),
    tax: obj.tax === '' || obj.tax === undefined ? 0 : Number(obj.tax),
    note: obj.note || '',
  };
}

function loadTransactions() {
  if (!fs.existsSync(CSV_PATH)) return [];
  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx] : ''; });
    return normalizeRow(obj);
  });
}

function saveTransactions(rows) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(CSV_PATH)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(CSV_PATH, path.join(BACKUP_DIR, `transactions-${stamp}.csv`));
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter((name) => /^transactions-.*\.csv$/.test(name))
      .sort()
      .reverse();
    backups.slice(30).forEach((name) => fs.unlinkSync(path.join(BACKUP_DIR, name)));
  }
  fs.writeFileSync(CSV_PATH, rowsToCsv(rows), 'utf8');
}

function newId() {
  return crypto.randomBytes(5).toString('hex');
}

// ---------- live price + fx (server-side fetch, no CORS, no API key) ----------
function loadPriceCache() {
  try {
    return JSON.parse(fs.readFileSync(PRICE_CACHE_PATH, 'utf8'));
  } catch (e) {
    return { prices: {}, fx: {} };
  }
}

function savePriceCache(cache) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PRICE_CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

// Serialises cache read-modify-write sections against each other. Each request
// loads the cache, awaits its network fetches, then writes - so two overlapping
// requests would otherwise both write a copy based on the pre-fetch state and
// the later one would drop the earlier one's entries (measured: 3 concurrent
// /api/prices requests covering 5 tickers persisted only 2). The lock is taken
// AFTER fetching, never around it, so tickers still download in parallel.
let cacheLock = Promise.resolve();
function withCacheLock(fn) {
  const result = cacheLock.then(fn, fn);
  cacheLock = result.then(() => {}, () => {});
  return result;
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchYahooPrice(ticker) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) + '?range=1d&interval=1d';
  const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  const meta = json && json.chart && json.chart.result && json.chart.result[0] && json.chart.result[0].meta;
  if (!meta || typeof meta.regularMarketPrice !== 'number') throw new Error('no price data for ' + ticker);
  return {
    price: meta.regularMarketPrice,
    prevClose: typeof meta.chartPreviousClose === 'number' ? meta.chartPreviousClose : meta.regularMarketPrice,
    currency: meta.currency || 'USD',
    // EQUITY / ETF / CRYPTOCURRENCY / INDEX / MUTUALFUND - ใช้จัดกลุ่มในหน้า
    // สัดส่วนพอร์ต มากับ response เดิมอยู่แล้ว ไม่ต้องยิง API เพิ่ม
    // (cache เก่าที่บันทึกก่อนมีฟิลด์นี้จะไม่มีค่า ฝั่ง client จึงเดาจากรูปแบบ
    // ticker เป็นทางสำรองไว้)
    type: meta.instrumentType || '',
    name: meta.longName || meta.shortName || '',
    asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : new Date().toISOString(),
  };
}

async function getPrices(tickers, forceRefresh = false) {
  const cache = loadPriceCache();
  const now = Date.now();
  const result = {};
  const freshlyFetched = {};

  await Promise.all(tickers.map(async (ticker) => {
    const cached = cache.prices[ticker];
    if (!forceRefresh && cached && now - cached.fetchedAt < PRICE_TTL_MS) {
      result[ticker] = { ...cached, stale: false };
      return;
    }
    try {
      const live = ticker === GOLD_TICKER ? await fetchGoldLive() : await fetchYahooPrice(ticker);
      const entry = { ...live, fetchedAt: now };
      freshlyFetched[ticker] = entry;
      result[ticker] = { ...entry, stale: false };
    } catch (e) {
      if (cached) result[ticker] = { ...cached, stale: true };
      else result[ticker] = { error: e.message || 'fetch failed' };
    }
  }));

  if (Object.keys(freshlyFetched).length > 0) {
    // Re-read inside the lock so entries another request wrote while we were
    // fetching survive, then merge only what we actually fetched.
    await withCacheLock(() => {
      const disk = loadPriceCache();
      Object.assign(disk.prices, freshlyFetched);
      savePriceCache(disk);
    });
  }
  return result;
}

// ---------- historical daily closes (for TWR / benchmark charts) ----------
function loadHistoryCache() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_CACHE_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveHistoryCache(cache) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_CACHE_PATH, JSON.stringify(cache), 'utf8');
}

async function fetchYahooHistory(ticker, period1, period2) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker)
    + '?period1=' + period1 + '&period2=' + period2 + '&interval=1d';
  const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result) throw new Error('no history for ' + ticker);
  const timestamps = result.timestamp || [];
  const closes = (result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || [];
  const series = [];
  let lastClose = null;
  for (let i = 0; i < timestamps.length; i++) {
    const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
    let close = closes[i];
    if (close === null || close === undefined) close = lastClose;
    if (close !== null && close !== undefined) { series.push({ date, close }); lastClose = close; }
  }
  return series;
}

// Takes the cache object rather than loading it itself, so a multi-ticker
// request can load once, let every ticker mutate the same in-memory object,
// then save once - see the /api/history handler. Loading/saving per-ticker
// inside a Promise.all let each ticker's save clobber the others' (measured:
// 5 tickers fetched, 1 persisted).
// Reads from the caller's cache snapshot and records anything it fetches into
// `freshlyFetched`, which the caller merges under withCacheLock once every
// ticker has settled - see the /api/history handler.
async function getHistory(cache, freshlyFetched, ticker, startDate) {
  const now = Date.now();
  const cached = cache[ticker];
  const cacheCoversStart = cached && cached.startDate <= startDate;

  if (cached && cacheCoversStart && now - cached.fetchedAt < HISTORY_TTL_MS) {
    return cached.series;
  }
  try {
    const period1 = Math.floor(new Date(startDate + 'T00:00:00Z').getTime() / 1000) - 86400;
    const period2 = Math.floor(now / 1000) + 86400;
    const series = await fetchYahooHistory(ticker, period1, period2);
    freshlyFetched[ticker] = { startDate, fetchedAt: now, series };
    return series;
  } catch (e) {
    if (cached) return cached.series;
    throw e;
  }
}

// ---------- per-ticker news (Yahoo's RSS feed - no API key, no news library) ----------
function loadNewsCache() {
  try { return JSON.parse(fs.readFileSync(NEWS_CACHE_PATH, 'utf8')); }
  catch (e) { return {}; }
}

function saveNewsCache(cache) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(NEWS_CACHE_PATH, JSON.stringify(cache), 'utf8');
}

// Handles the entities actually verified in Yahoo's feed (&amp; only, in
// practice) plus the rest of the standard XML/HTML named + numeric set for
// safety. A single regex pass over the ORIGINAL string - never chained
// .replace() calls - so an already-double-encoded "&amp;lt;" decodes to
// "&lt;" (one layer), never all the way to "<".
function decodeXmlEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return String(s || '').replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] !== '#') return named[body] || m;
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

// Verified live against Yahoo's actual feed: items carry <title>/<link>/
// <pubDate>/<guid> only - no <source>/<dc:creator>/<author>, so there is no
// publisher name to surface, only the ticker + timestamp. No CDATA, but
// titles do carry real entities ("Procter &amp; Gamble") - decoded here so
// callers only ever need to escape, never decode. Item order in the feed is
// NOT chronological (verified: pubDates come back as 26,26,27,26,25,28,...
// within one feed) - sort by publishedAt if order matters to the caller.
function parseRssItems(xml) {
  const items = [];
  const blocks = String(xml || '').split('<item>').slice(1);
  for (const block of blocks) {
    const body = block.split('</item>')[0];
    const title = (body.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    const link = (body.match(/<link>([\s\S]*?)<\/link>/) || [])[1];
    const pubDate = (body.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
    const guid = (body.match(/<guid[^>]*>([\s\S]*?)<\/guid>/) || [])[1];
    if (!title || !link) continue; // no headline, or nowhere to send the click - skip
    const parsedDate = pubDate ? new Date(pubDate) : null;
    items.push({
      id: decodeXmlEntities((guid || link)).trim(),
      title: decodeXmlEntities(title).trim(),
      link: decodeXmlEntities(link).trim(),
      publishedAt: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null,
    });
  }
  return items;
}

async function fetchYahooNews(ticker) {
  const url = 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=' + encodeURIComponent(ticker) + '&region=US&lang=en-US';
  const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const xml = await res.text();
  return parseRssItems(xml).slice(0, 10); // caps cache file size - client-side dedupe/sort/cap happens on top of this
}

// Same load-once/fetch-many/save-once discipline as getHistory above (see its
// comment for the measured "5 fetched, 1 persisted" bug this avoids) - cache
// is the caller's already-loaded snapshot, freshlyFetched collects anything
// fetched here for the caller to merge under one withCacheLock.
async function getNews(cache, freshlyFetched, ticker, forceRefresh = false) {
  const now = Date.now();
  const cached = cache[ticker];
  if (!forceRefresh && cached && now - cached.fetchedAt < NEWS_TTL_MS) {
    return cached.items;
  }
  try {
    const items = await fetchYahooNews(ticker);
    freshlyFetched[ticker] = { fetchedAt: now, items };
    return items;
  } catch (e) {
    if (cached) return cached.items;
    throw e;
  }
}

async function getFxRate(base, quote) {
  const cache = loadPriceCache();
  const key = base + '_' + quote;
  const now = Date.now();
  const cached = cache.fx[key];
  if (cached && now - cached.fetchedAt < FX_TTL_MS) return { rate: cached.rate, stale: false };
  try {
    const url = 'https://api.frankfurter.dev/v1/latest?base=' + encodeURIComponent(base) + '&symbols=' + encodeURIComponent(quote);
    const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const rate = json && json.rates && json.rates[quote];
    if (typeof rate !== 'number') throw new Error('no rate data');
    await withCacheLock(() => {
      const disk = loadPriceCache();
      disk.fx[key] = { rate, fetchedAt: now };
      savePriceCache(disk);
    });
    return { rate, stale: false };
  } catch (e) {
    if (cached) return { rate: cached.rate, stale: true };
    return null;
  }
}

// ---------- symbol search (typeahead ของช่อง ticker) ----------
const SEARCH_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_MAX = 200;
// เก็บใน memory อย่างเดียว ไม่ลงดิสก์: ผลค้นหาเป็นแค่คำแนะนำชั่วคราว ไม่ใช่ข้อมูลพอร์ต
// ไม่มีอะไรต้องรอดข้าม restart - และเพราะไม่เขียนไฟล์ จึงไม่ต้องใช้ withCacheLock
// (ต่างจาก price/history cache ที่ต้องมี lock เพราะเขียนไฟล์ร่วมกัน)
const searchCache = new Map();

// Yahoo's search mixes option/futures contracts into plain queries - e.g.
// q=goog returns "GOOGL261218C00345000" (an options contract) alongside
// GOOG/GOOGL (verified live). Those aren't tickers a portfolio transaction
// would ever use, so only keep instrument types this app can actually track.
const SEARCHABLE_TYPES = new Set(['EQUITY', 'ETF', 'MUTUALFUND', 'CRYPTOCURRENCY', 'INDEX']);

async function searchSymbols(query) {
  const key = query.toLowerCase();
  const now = Date.now();
  const cached = searchCache.get(key);
  if (cached && now - cached.fetchedAt < SEARCH_TTL_MS) return cached.results;

  const url = 'https://query1.finance.yahoo.com/v1/finance/search?q=' + encodeURIComponent(query)
    + '&quotesCount=15&newsCount=0&listsCount=0';
  const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  const quotes = json && Array.isArray(json.quotes) ? json.quotes : [];
  const results = quotes
    .filter((q) => q && typeof q.symbol === 'string' && q.isYahooFinance !== false
      && SEARCHABLE_TYPES.has(String(q.quoteType || '').toUpperCase()))
    .slice(0, 8)
    .map((q) => ({
      symbol: q.symbol.toUpperCase(),
      name: q.longname || q.shortname || '',
      exchange: q.exchDisp || q.exchange || '',
      type: q.typeDisp || q.quoteType || '',
    }));

  if (searchCache.size >= SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
  searchCache.set(key, { fetchedAt: now, results });
  return results;
}

// ---------- Thai gold (GOLD-THB pseudo-ticker) ----------
// Yahoo has no Thai gold data. api.chnwt.dev/thai-gold-api proxies the Thai
// Gold Traders Association rate for free, but only exposes "/latest" - no
// history. So history is built by recording one real snapshot per calendar
// day, every time this app is used, starting from whenever this feature
// first runs. There is no way to backfill genuine prices from before that.
const GOLD_TICKER = 'GOLD-THB';
const GOLD_BAHT_WEIGHT_GRAMS = 15.244; // legal Thai definition: 1 บาททองคำ = 15.244 g
const GOLD_HISTORY_PATH = path.join(DATA_DIR, 'gold-thb-history.json');

async function fetchThaiGoldSpotPerGram() {
  const res = await fetchWithTimeout('https://api.chnwt.dev/thai-gold-api/latest', FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  const bar = json && json.response && json.response.price && json.response.price.gold_bar;
  const buy = bar && Number(String(bar.buy).replace(/,/g, ''));
  if (!(buy > 0)) throw new Error('no gold_bar.buy in response');
  // "buy" = the price a shop pays to buy gold back from a customer - the
  // honest mark-to-market value of an existing holding (not the higher
  // "sell" price, which is what it'd cost to buy MORE gold right now).
  return buy / GOLD_BAHT_WEIGHT_GRAMS; // THB per gram, raw (not USD-converted here)
}

function loadGoldHistory() {
  try { return JSON.parse(fs.readFileSync(GOLD_HISTORY_PATH, 'utf8')); }
  catch (e) { return { series: [] }; }
}

function saveGoldHistory(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(GOLD_HISTORY_PATH, JSON.stringify(data), 'utf8');
}

// Fetch happens BEFORE the lock (same discipline as the price/history caches
// above) so it never holds the lock during a slow network call; only the
// read-modify-write around the file itself is serialized.
async function ensureTodaysGoldSnapshot() {
  const today = todayLocalISO();
  const data = loadGoldHistory();
  const last = data.series[data.series.length - 1];
  if (last && last.date === today) return data; // already recorded today

  let close;
  try { close = await fetchThaiGoldSpotPerGram(); }
  catch (e) { return data; } // couldn't fetch - leave log as-is, try again next request

  return withCacheLock(() => {
    const disk = loadGoldHistory();
    if (!disk.series.length || disk.series[disk.series.length - 1].date !== today) {
      disk.series.push({ date: today, close });
      saveGoldHistory(disk);
    }
    return disk;
  });
}

async function fetchGoldLive() {
  const data = await ensureTodaysGoldSnapshot();
  const series = data.series;
  if (series.length === 0) throw new Error('no gold price available yet');
  const today = series[series.length - 1];
  const prev = series.length >= 2 ? series[series.length - 2] : today; // <2 points -> day change shows 0
  return { price: today.close, prevClose: prev.close, currency: 'THB', asOf: new Date().toISOString() };
}

// Returns [{date,close}] (raw THB/gram) covering startDate..today. Dates
// before the log's first real snapshot are backfilled FLAT at that first
// known price - not real history (none exists), but this keeps portfolio
// value continuous instead of showing GOLD-THB as worth nothing before
// tracking began, which would otherwise look like a fake huge 1-day "return"
// the moment tracking starts (TimeSeries.dailyTWR has no way to know the gap
// isn't a real loss-then-gain).
async function getGoldHistory(startDate) {
  const data = await ensureTodaysGoldSnapshot();
  if (data.series.length === 0) return [];
  if (data.series[0].date <= startDate) return data.series;
  return [{ date: startDate, close: data.series[0].close }, ...data.series];
}

// ---------- historical FX rates (for converting non-USD transactions/prices) ----------
const FX_HISTORY_PATH = path.join(DATA_DIR, 'fx-history-cache.json');

function loadFxHistoryCache() {
  try { return JSON.parse(fs.readFileSync(FX_HISTORY_PATH, 'utf8')); }
  catch (e) { return {}; }
}

function saveFxHistoryCache(cache) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FX_HISTORY_PATH, JSON.stringify(cache), 'utf8');
}

async function fetchFxHistoryRange(currency, startDate, endDate) {
  const url = 'https://api.frankfurter.dev/v1/' + startDate + '..' + endDate
    + '?base=USD&symbols=' + encodeURIComponent(currency);
  const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  const rates = (json && json.rates) || {};
  return Object.keys(rates)
    .map((date) => ({ date, close: rates[date][currency] }))
    .filter((p) => typeof p.close === 'number')
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Mirrors getHistory()'s cache-then-fetch-then-lock pattern exactly, keyed by
// currency instead of ticker, in its own file so it never collides with the
// per-ticker history cache's shape/semantics.
async function getFxHistory(currency, startDate) {
  const cache = loadFxHistoryCache();
  const now = Date.now();
  const cached = cache[currency];
  const cacheCoversStart = cached && cached.startDate <= startDate;

  if (cached && cacheCoversStart && now - cached.fetchedAt < HISTORY_TTL_MS) {
    return cached.series;
  }
  try {
    const series = await fetchFxHistoryRange(currency, startDate, todayLocalISO());
    await withCacheLock(() => {
      const disk = loadFxHistoryCache();
      disk[currency] = { startDate, fetchedAt: now, series };
      saveFxHistoryCache(disk);
    });
    return series;
  } catch (e) {
    if (cached) return cached.series;
    throw e;
  }
}

// ---------- validation (HTTP boundary) ----------
function validateInput(body) {
  const errors = [];
  const date = String(body.date || '').trim();
  const action = String(body.action || '').trim();
  const ticker = String(body.ticker || '').trim();
  const price = Number(body.price);
  const shares = Number(body.shares);
  const commission = body.commission === undefined || body.commission === '' ? 0 : Number(body.commission);
  const amount = body.amount === undefined || body.amount === '' ? 0 : Number(body.amount);
  const tax = body.tax === undefined || body.tax === '' ? 0 : Number(body.tax);
  const currency = String(body.currency || 'USD').trim() || 'USD';
  const note = String(body.note || '').trim();

  if (!date) errors.push('date is required');
  else if (!DATE_RE.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00Z'))) errors.push('date must be a valid date (YYYY-MM-DD)');
  else if (date > todayLocalISO()) errors.push('date cannot be in the future');
  if (!VALID_ACTIONS.includes(action)) errors.push('action must be one of: ' + VALID_ACTIONS.join(', '));
  if (!ticker) errors.push('ticker is required');
  if (action === 'Dividend') {
    if (!Number.isFinite(amount) || amount <= 0) errors.push('amount must be a positive number for Dividend');
  } else if (!Number.isFinite(shares) || shares <= 0) errors.push('shares must be a positive number');
  if (!Number.isFinite(price) || price < 0) errors.push('price must be a non-negative number');
  // Buy/Sell with price=0 silently zeroes out cost basis (unrealized gain
  // then shows the full market value as "profit"). Transfer in/out are
  // still allowed to have no price - a transfer isn't a purchase.
  else if ((action === 'Buy' || action === 'Sell') && price === 0) errors.push('price is required for Buy/Sell');
  if (!Number.isFinite(commission) || commission < 0) errors.push('commission must be a non-negative number');
  if (!Number.isFinite(tax) || tax < 0) errors.push('tax must be a non-negative number');
  if (action === 'Dividend' && tax > amount) errors.push('tax cannot exceed dividend amount');

  return { errors, value: { date, action, ticker: ticker.toUpperCase(), price, currency, shares, commission, amount, tax, note } };
}

// ---------- HTTP plumbing ----------
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel);
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const urlPath = req.url.split('?')[0];

    if (urlPath === '/api/transactions' && req.method === 'GET') {
      return sendJson(res, 200, loadTransactions());
    }

    if (urlPath === '/api/transactions/export' && req.method === 'GET') {
      const filename = `portfolio-transactions-${todayLocalISO()}.csv`;
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      });
      return res.end('\uFEFF' + rowsToCsv(loadTransactions()));
    }

    if (urlPath === '/api/transactions' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const { errors, value } = validateInput(body);
      if (errors.length) return sendJson(res, 400, { error: errors.join(', ') });
      const rows = loadTransactions();
      const created = { id: newId(), ...value };
      rows.push(created);
      saveTransactions(rows);
      return sendJson(res, 201, created);
    }

    if (urlPath === '/api/transactions/bulk' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const items = Array.isArray(body.rows) ? body.rows : [];
      const rows = loadTransactions();
      const inserted = [];
      const rejected = [];
      for (const item of items) {
        const { errors, value } = validateInput(item);
        if (errors.length) { rejected.push({ item, errors }); continue; }
        const row = { id: newId(), ...value };
        rows.push(row);
        inserted.push(row);
      }
      saveTransactions(rows);
      return sendJson(res, 201, { insertedCount: inserted.length, inserted, rejected });
    }

    const idMatch = urlPath.match(/^\/api\/transactions\/([a-zA-Z0-9_-]+)$/);
    if (idMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const id = idMatch[1];
      const rows = loadTransactions();
      const idx = rows.findIndex((r) => r.id === id);
      if (idx === -1) return sendJson(res, 404, { error: 'transaction not found' });

      if (req.method === 'DELETE') {
        rows.splice(idx, 1);
        saveTransactions(rows);
        return sendJson(res, 200, { ok: true });
      }

      const body = await readJsonBody(req);
      const merged = { ...rows[idx], ...body };
      const { errors, value } = validateInput(merged);
      if (errors.length) return sendJson(res, 400, { error: errors.join(', ') });
      rows[idx] = { id, ...value };
      saveTransactions(rows);
      return sendJson(res, 200, rows[idx]);
    }

    if (urlPath === '/api/prices' && req.method === 'GET') {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const tickersParam = parsedUrl.searchParams.get('tickers') || '';
      const tickers = [...new Set(tickersParam.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean))];
      const forceRefresh = parsedUrl.searchParams.has('refresh');
      const prices = tickers.length ? await getPrices(tickers, forceRefresh) : {};
      const fx = await getFxRate('USD', 'THB');
      return sendJson(res, 200, { prices, fx });
    }

    if (urlPath === '/api/history' && req.method === 'GET') {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const tickersParam = parsedUrl.searchParams.get('tickers') || '';
      const start = parsedUrl.searchParams.get('start') || '2020-01-01';
      const tickers = [...new Set(tickersParam.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean))];
      const historyCache = loadHistoryCache();
      const freshHistory = {};
      const out = {};
      await Promise.all(tickers.map(async (t) => {
        try { out[t] = t === GOLD_TICKER ? await getGoldHistory(start) : await getHistory(historyCache, freshHistory, t, start); } catch (e) { out[t] = { error: e.message || 'fetch failed' }; }
      }));
      if (Object.keys(freshHistory).length > 0) {
        await withCacheLock(() => {
          const disk = loadHistoryCache();
          Object.assign(disk, freshHistory);
          saveHistoryCache(disk);
        });
      }
      return sendJson(res, 200, out);
    }

    if (urlPath === '/api/news' && req.method === 'GET') {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const tickersParam = parsedUrl.searchParams.get('tickers') || '';
      const tickers = [...new Set(tickersParam.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean))];
      const forceRefresh = parsedUrl.searchParams.has('refresh');
      const newsCache = loadNewsCache();
      const freshNews = {};
      const out = {};
      await Promise.all(tickers.map(async (t) => {
        try { out[t] = await getNews(newsCache, freshNews, t, forceRefresh); } catch (e) { out[t] = { error: e.message || 'fetch failed' }; }
      }));
      if (Object.keys(freshNews).length > 0) {
        await withCacheLock(() => {
          const disk = loadNewsCache();
          Object.assign(disk, freshNews);
          saveNewsCache(disk);
        });
      }
      return sendJson(res, 200, out);
    }

    if (urlPath === '/api/search' && req.method === 'GET') {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const q = (parsedUrl.searchParams.get('q') || '').trim().slice(0, 40);
      if (!q) return sendJson(res, 200, { results: [] });
      try {
        return sendJson(res, 200, { results: await searchSymbols(q) });
      } catch (e) {
        // เน็ตล่ม/Yahoo ล่ม ต้องไม่ทำให้พิมพ์ต่อไม่ได้ - ตอบ 200 พร้อม results ว่าง
        // แล้วให้ฝั่ง client ถอยไปใช้ ticker ในเลดเจอร์แทน
        return sendJson(res, 200, { results: [], error: e.message || 'search failed' });
      }
    }

    if (urlPath === '/api/fx-history' && req.method === 'GET') {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const currency = (parsedUrl.searchParams.get('currency') || '').trim().toUpperCase();
      const start = parsedUrl.searchParams.get('start') || todayLocalISO();
      if (!currency || currency === 'USD') return sendJson(res, 200, { series: [] });
      try {
        return sendJson(res, 200, { series: await getFxHistory(currency, start) });
      } catch (e) {
        return sendJson(res, 200, { series: [], error: e.message || 'fx history failed' });
      }
    }

    if (urlPath.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'unknown endpoint' });
    }

    return serveStatic(req, res, urlPath);
  } catch (e) {
    sendJson(res, 500, { error: e.message || 'internal error' });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('เซิร์ฟเวอร์เปิดอยู่แล้วที่ http://127.0.0.1:' + PORT + '/ — เปิดลิงก์นี้ในเบราว์เซอร์ได้เลย');
    console.log('(ถ้าไม่ใช่ ให้ปิดโปรแกรมอื่นที่ใช้พอร์ต ' + PORT + ' ก่อน แล้วลองใหม่)');
    process.exit(0);
  }
  console.error('เซิร์ฟเวอร์เริ่มไม่สำเร็จ:', err.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Portfolio server running at http://127.0.0.1:' + PORT + '/');
  console.log('Data file: ' + CSV_PATH);
  console.log('Press Ctrl+C in this window to stop the server.');
});
