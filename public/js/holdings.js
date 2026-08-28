// Average-cost holdings calculator, driven purely by the transaction ledger
// (no live price yet - that lands in phase 2).
const Holdings = (() => {
  function compute(transactions) {
    const sorted = [...transactions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const byTicker = new Map();

    for (const tx of sorted) {
      const ticker = tx.ticker;
      if (!byTicker.has(ticker)) {
        byTicker.set(ticker, { ticker, shares: 0, costBasis: 0, realizedPL: 0, oversoldShares: 0 });
      }
      const h = byTicker.get(ticker);
      const shares = Number(tx.shares) || 0;
      const price = Number(tx.price) || 0;
      const commission = Number(tx.commission) || 0;
      const action = (tx.action || '').toLowerCase();

      if (action === 'buy' || action === 'transfer in') {
        h.costBasis += shares * price + commission;
        h.shares += shares;
      } else if (action === 'sell' || action === 'transfer out') {
        const avgCost = h.shares > 1e-9 ? h.costBasis / h.shares : 0;
        const sellShares = Math.min(shares, h.shares);
        // A sell/transfer-out larger than what's on record means shares existed
        // before the ledger's earliest entry - flag it rather than silently
        // clamping, since it also means costBasis/realizedPL below are understated.
        h.oversoldShares += shares - sellShares;
        if (action === 'sell') {
          h.realizedPL += sellShares * (price - avgCost) - commission;
        }
        h.costBasis -= sellShares * avgCost;
        h.shares -= sellShares;
      }
    }

    return [...byTicker.values()]
      .filter((h) => Math.abs(h.shares) > 1e-9 || Math.abs(h.realizedPL) > 1e-9 || h.oversoldShares > 1e-9)
      .map((h) => ({
        ticker: h.ticker,
        shares: h.shares,
        avgCost: h.shares > 1e-9 ? h.costBasis / h.shares : 0,
        costBasis: h.costBasis,
        realizedPL: h.realizedPL,
        oversoldShares: h.oversoldShares,
      }))
      .sort((a, b) => b.costBasis - a.costBasis);
  }

  return { compute };
})();
