// Single place in the whole app that multiplies or divides by an exchange
// rate. server.js only ever fetches/caches raw prices (whatever currency the
// upstream source reports, e.g. THB for GOLD-THB or a Thai Yahoo ticker) -
// every conversion to USD happens here, so there is exactly one place to
// audit if a total ever looks wrong.
//
// data/transactions.csv itself is NEVER touched by this module - the
// Transactions page always shows/edits the raw figures the user entered.
// Only Home/Allocation/Performance (the pages that sum everything into one
// portfolio total) need USD-normalized numbers.
const Currency = (() => {
  // series: [{date,close}] sorted ascending by date. Forward-fills from the
  // most recent point <= targetDate. If targetDate is before the series even
  // starts, flat-extends the EARLIEST known rate backward - no rate exists
  // before the series begins, and assuming the earliest known rate is far
  // safer than treating the amount as 0 or leaving it unconverted.
  function rateOnDate(series, targetDate) {
    if (!series || series.length === 0) return null;
    let rate = series[0].close;
    for (const pt of series) {
      if (pt.date > targetDate) break;
      rate = pt.close;
    }
    return rate;
  }

  // Converts ledger transactions whose currency != USD to USD-equivalent,
  // using the historical USD->currency rate on EACH transaction's own date -
  // not today's rate, so cost basis reflects what was actually paid that day.
  // Returns a NEW array; never mutates the input.
  //
  // A transaction whose rate can't be found (fx fetch failed) is DROPPED, not
  // passed through with its raw price - dropping only understates the
  // portfolio slightly (same as the existing "unpriced position" pattern),
  // while passing raw THB numbers through as if they were USD would inflate
  // the portfolio by roughly the exchange rate (~30x for THB). Never do that.
  async function normalizeTransactions(transactions) {
    const nonUsd = transactions.filter((t) => t.currency && t.currency !== 'USD');
    if (nonUsd.length === 0) return { transactions, droppedCount: 0 };

    const earliestByCcy = {};
    nonUsd.forEach((t) => {
      if (!earliestByCcy[t.currency] || t.date < earliestByCcy[t.currency]) earliestByCcy[t.currency] = t.date;
    });

    const seriesByCcy = {};
    await Promise.all(Object.keys(earliestByCcy).map(async (ccy) => {
      try {
        const res = await Api.fxHistory(ccy, earliestByCcy[ccy]);
        seriesByCcy[ccy] = Array.isArray(res.series) ? res.series : [];
      } catch (e) {
        seriesByCcy[ccy] = []; // offline/server down - handled below (transaction dropped, not corrupted)
      }
    }));

    let droppedCount = 0;
    const out = [];
    for (const t of transactions) {
      if (!t.currency || t.currency === 'USD') { out.push(t); continue; }
      const rate = rateOnDate(seriesByCcy[t.currency], t.date);
      if (!rate) { droppedCount++; continue; }
      out.push({
        ...t,
        price: t.price / rate,
        commission: t.commission / rate,
        origCurrency: t.currency,
        currency: 'USD',
        fxRate: rate,
      });
    }
    return { transactions: out, droppedCount };
  }

  // Converts a /api/prices-style priceMap to USD, using the "fx" rate (a
  // single today's USD->THB rate) the endpoint already returns alongside it.
  // Only THB is supported right now - that's every non-USD ticker this app
  // can currently produce (GOLD-THB, or a Thai stock quoted through Yahoo).
  function normalizePrices(priceMap, fx) {
    const out = {};
    for (const [ticker, p] of Object.entries(priceMap || {})) {
      if (!p || p.error || !p.currency || p.currency === 'USD') { out[ticker] = p; continue; }
      if (p.currency !== 'THB' || !fx) { out[ticker] = { error: 'no fx rate for ' + p.currency }; continue; }
      out[ticker] = {
        ...p,
        price: p.price / fx.rate,
        prevClose: p.prevClose != null ? p.prevClose / fx.rate : p.prevClose,
        origCurrency: p.currency,
        currency: 'USD',
      };
    }
    return out;
  }

  // Converts a /api/history-style {date,close}[] series (for ONE ticker whose
  // native currency is known) to USD, using EACH point's own date rate - not
  // today's rate - so historical portfolio valuation (TWR) stays accurate.
  //
  // series can be SPARSE (e.g. GOLD-THB's server-side backfill is just 2
  // points: the earliest requested date, and today - there is no free
  // source for the days between). Converting those 2 points with their own
  // dates' rates and THEN letting the caller's forwardFill() carry the
  // already-converted USD value across the whole gap would freeze it at
  // ONE stale date's rate for months - hiding real day-to-day FX movement
  // and, worse, creating a fake value jump on any date in the middle of the
  // gap where a transaction happens to land (that transaction's own cost
  // basis uses ITS date's real rate, but the valuation series used a much
  // older/newer rate for the same day - the two disagree, and the
  // difference shows up as a fake 1-day "return").
  //
  // Fix: walk every date the FX series itself has (dense, business-day
  // granularity - same as any Yahoo-sourced ticker's own history, so this
  // introduces no new gap the rest of the pipeline doesn't already handle),
  // forward-fill the RAW native-currency price at each of those dates
  // FIRST, then convert using THAT SAME day's own rate. reuses rateOnDate
  // as a generic "carried-forward value at date" lookup - it doesn't care
  // whether the series holds prices or FX rates.
  async function normalizeHistorySeries(series, currency) {
    if (!Array.isArray(series) || series.length === 0 || !currency || currency === 'USD') return series;
    let fxSeries = [];
    try { fxSeries = (await Api.fxHistory(currency, series[0].date)).series || []; }
    catch (e) { return []; }
    if (fxSeries.length === 0) return [];
    return fxSeries
      .filter((fx) => fx.date >= series[0].date)
      .map((fx) => {
        const nativePrice = rateOnDate(series, fx.date);
        return nativePrice ? { date: fx.date, close: nativePrice / fx.close } : null;
      })
      .filter(Boolean);
  }

  return { normalizeTransactions, normalizePrices, normalizeHistorySeries };
})();
