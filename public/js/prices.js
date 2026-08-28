const Prices = (() => {
  async function fetchFor(tickers) {
    if (!tickers || tickers.length === 0) return { prices: {}, fx: null };
    const qs = encodeURIComponent(tickers.join(','));
    const res = await fetch('/api/prices?tickers=' + qs);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  return { fetchFor };
})();
