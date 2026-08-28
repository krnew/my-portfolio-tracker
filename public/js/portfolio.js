// Merges the ledger-derived holdings (Holdings.compute) with live price data
// (Prices.fetchFor) into the rows + totals both Home and Allocation render.
const Portfolio = (() => {
  function enrich(holdings, priceMap) {
    const rows = holdings.map((h) => {
      const p = priceMap[h.ticker];
      const price = p && typeof p.price === 'number' ? p.price : null;
      const prevClose = p && typeof p.prevClose === 'number' ? p.prevClose : null;
      const hasPosition = h.shares > 1e-9;
      const marketValue = hasPosition && price !== null ? h.shares * price : null;
      const unrealizedGain = marketValue !== null ? marketValue - h.costBasis : null;
      const dayChange = hasPosition && price !== null && prevClose !== null ? h.shares * (price - prevClose) : null;
      return {
        ...h,
        price,
        prevClose,
        marketValue,
        unrealizedGain,
        dayChange,
        priceError: p && p.error ? p.error : null,
        stale: !!(p && p.stale),
        asOf: p ? p.asOf : null,
      };
    });

    const totalMarketValue = rows.reduce((s, r) => s + (r.marketValue || 0), 0);
    const totalCostBasis = rows.reduce((s, r) => s + r.costBasis, 0);
    const totalRealizedPL = rows.reduce((s, r) => s + r.realizedPL, 0);
    const totalDayChange = rows.reduce((s, r) => s + (r.dayChange || 0), 0);
    const totalPrevValue = rows.reduce((s, r) => {
      if (r.shares > 1e-9 && r.prevClose !== null) return s + r.shares * r.prevClose;
      return s + (r.marketValue || 0);
    }, 0);

    const withAlloc = rows.map((r) => ({
      ...r,
      allocationPct: totalMarketValue > 0 && r.marketValue !== null ? (r.marketValue / totalMarketValue) * 100 : 0,
    })).sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0));

    return {
      rows: withAlloc,
      totalMarketValue,
      totalCostBasis,
      // Sum of per-row gains (each already null when unpriceable), NOT
      // totalMarketValue - totalCostBasis - that would subtract cost basis
      // for rows whose market value couldn't be fetched, understating the total.
      totalUnrealizedGain: rows.reduce((s, r) => s + (r.unrealizedGain || 0), 0),
      totalRealizedPL,
      totalDayChange,
      totalDayChangePct: totalPrevValue > 0 ? (totalDayChange / totalPrevValue) * 100 : 0,
    };
  }

  return { enrich };
})();
