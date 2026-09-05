const News = (() => {
  async function fetchFor(tickers) {
    if (!tickers || tickers.length === 0) return {};
    const qs = encodeURIComponent(tickers.join(','));
    const force = new URLSearchParams(location.search).has('refresh') ? '&refresh=1' : '';
    const res = await fetch('/api/news?tickers=' + qs + force);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  return { fetchFor };
})();
