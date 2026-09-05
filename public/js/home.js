const NEWS_MAX_TICKERS = 8;
const NEWS_MAX_ITEMS = 20;
// A quiet ticker's feed can go stale for months (verified live: a Thai
// .BK ticker's oldest item was ~9 months old, vs. ~5 days for a busy US
// one) - without a cutoff, round-robin's fairness guarantee (every held
// ticker gets a slot) means that ancient item still earns a slot right next
// to this morning's news. Cap how old an item can be before it's eligible at all.
const NEWS_MAX_AGE_DAYS = 30;

function newsTimeAgo(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hours = (Date.now() - d.getTime()) / 3600000;
  if (hours < 1) return 'เมื่อสักครู่';
  if (hours < 24) return Math.floor(hours) + ' ชม.ที่แล้ว';
  const days = Math.floor(hours / 24);
  if (days === 1) return 'เมื่อวาน';
  if (days < 7) return days + ' วันที่แล้ว';
  // Past a week the label drops to a bare day+month ("5 พ.ย.") - fine within
  // the same year, but indistinguishable from a year-old date without one.
  // Only add the year when it's not the current one, so today's news stays
  // as short as before.
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('th-TH', sameYear
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

// No publishedAt, or one that fails to parse, is rare (every feed tested so
// far has it) but must never be treated as "too old" - dropping real content
// because of a parse gap is worse than occasionally showing an undated item.
function isWithinNewsWindow(publishedAt) {
  if (!publishedAt) return true;
  const t = new Date(publishedAt).getTime();
  if (Number.isNaN(t)) return true;
  return Date.now() - t <= NEWS_MAX_AGE_DAYS * 86400000;
}

// escapeHtml alone stops markup injection but not a "javascript:" href -
// only ever link out to http(s).
function isSafeHttpUrl(url) {
  try {
    const u = new URL(url, location.origin);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

// Sidebar convenience, not core portfolio data - every failure path here
// degrades to a message in the news panel and must never throw up into
// render()'s own try/catch (which would take the Holdings table down with
// it). Deliberately not awaited by its caller so it loads in parallel with
// the price fetch instead of delaying the table's first paint.
async function renderNews(tickers) {
  const wrap = document.getElementById('news-list');
  if (!wrap) return;
  const relevantTickers = tickers.filter((t) => t !== 'GOLD-THB').slice(0, NEWS_MAX_TICKERS);
  if (relevantTickers.length === 0) {
    wrap.innerHTML = '<p class="note" style="padding:0;">ยังไม่มีโพซิชันที่มีข่าวให้ติดตาม</p>';
    return;
  }
  try {
    const newsMap = await News.fetchFor(relevantTickers);
    const byTime = (a, b) => (b.publishedAt ? new Date(b.publishedAt).getTime() : 0) - (a.publishedAt ? new Date(a.publishedAt).getTime() : 0);

    // Round-robin across tickers (each ticker's own items newest-first)
    // instead of one global recency sort - verified live that a 24/7 ticker
    // (crypto) publishes many times a day while a stock's feed can go a few
    // days quiet, so a pure global sort lets the noisy ticker's updates fill
    // every slot and crowd a bigger, quieter holding out of the list
    // entirely. Taking one from each ticker per round guarantees every held
    // ticker gets a fair share regardless of how often it publishes.
    const queues = relevantTickers.map((ticker) => ({
      ticker,
      items: (Array.isArray(newsMap[ticker]) ? newsMap[ticker] : [])
        .filter((it) => it && it.id && it.title && it.link && isWithinNewsWindow(it.publishedAt))
        .slice().sort(byTime),
      idx: 0,
    }));

    // Same story often lists several held tickers as related - dedupe by id
    // and merge which tickers surfaced it into one row instead of repeating
    // the same headline once per ticker.
    const byId = new Map();
    const merged = [];
    for (let round = 0; merged.length < NEWS_MAX_ITEMS && queues.some((q) => q.idx < q.items.length); round++) {
      for (const q of queues) {
        if (q.idx >= q.items.length) continue;
        const item = q.items[q.idx++];
        const existing = byId.get(item.id);
        if (existing) { if (!existing.tickers.includes(q.ticker)) existing.tickers.push(q.ticker); continue; }
        const entry = { ...item, tickers: [q.ticker] };
        byId.set(item.id, entry);
        merged.push(entry);
      }
    }
    merged.length = Math.min(merged.length, NEWS_MAX_ITEMS);

    if (merged.length === 0) {
      wrap.innerHTML = '<p class="note" style="padding:0;">ไม่พบข่าวสำหรับ ticker ที่ถืออยู่</p>';
      return;
    }

    wrap.innerHTML = merged.map((item) => {
      const badges = item.tickers.map((t) => `<span class="news-badge">${escapeHtml(t)}</span>`).join('');
      const timeLabel = newsTimeAgo(item.publishedAt);
      const timeHtml = timeLabel ? `<span class="news-time">${escapeHtml(timeLabel)}</span>` : '';
      const hrefAttrs = isSafeHttpUrl(item.link)
        ? `href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer"`
        : 'href="#" tabindex="-1" aria-disabled="true"'; // malformed/non-http link from the feed - render inert, never as a live link
      return `
        <a class="news-item" ${hrefAttrs}>
          <div class="news-title">${escapeHtml(item.title)}</div>
          <div class="news-meta">${badges}${timeHtml}</div>
        </a>`;
    }).join('');
  } catch (e) {
    wrap.innerHTML = '<p class="note" style="padding:0;">โหลดข่าวไม่สำเร็จ</p>';
  }
}

async function render() {
  const body = document.getElementById('holdings-body');
  try {
    const { transactions, droppedCount } = await Currency.normalizeTransactions(await Api.list());
    const holdings = Holdings.compute(transactions);
    const openTickers = holdings.filter((h) => h.shares > 1e-9).map((h) => h.ticker);
    renderNews(openTickers); // fire-and-forget: paints its own panel independently, see comment above

    let priceData = { prices: {}, fx: null };
    try {
      priceData = await Prices.fetchFor(openTickers);
    } catch (e) {
      // price service unreachable - fall back to cost-basis-only view below
    }
    AppUI.updatePriceStatus(priceData.prices, priceData.fx);
    priceData.prices = Currency.normalizePrices(priceData.prices, priceData.fx);

    const fxWarningEl = document.getElementById('fx-warning');
    if (droppedCount > 0) {
      fxWarningEl.textContent = `⚠️ ไม่รวม ${droppedCount} ธุรกรรมที่แปลงสกุลเงินเป็น USD ไม่ได้ (เน็ตล่มตอนโหลด) — ยอดพอร์ตด้านล่างจึงอาจน้อยกว่าความจริง ลองรีเฟรชอีกครั้ง`;
      fxWarningEl.style.display = 'block';
    } else {
      fxWarningEl.style.display = 'none';
    }

    const p = Portfolio.enrich(holdings, priceData.prices);

    setTile('tile-value', 'tile-value-sub', fmtMoney(p.totalMarketValue),
      priceData.fx ? fmtBaht(p.totalMarketValue * priceData.fx.rate) : '');
    setTile('tile-today', null, fmtMoney(p.totalDayChange) + '  ' + fmtPct(p.totalDayChangePct), null, signClass(p.totalDayChange));
    setTile('tile-unrealized', null, fmtMoney(p.totalUnrealizedGain), null, signClass(p.totalUnrealizedGain));
    setTile('tile-realized', null, fmtMoney(p.totalRealizedPL), null, signClass(p.totalRealizedPL));
    const currentYear = todayLocalISO().slice(0, 4);
    const dividendYtd = transactions
      .filter((t) => t.action === 'Dividend' && t.date.startsWith(currentYear))
      .reduce((sum, t) => sum + Math.max(0, (Number(t.amount) || 0) - (Number(t.tax) || 0)), 0);
    setTile('tile-dividend', null, fmtMoney(dividendYtd), null, dividendYtd > 0 ? 'pos' : '');

    const oversold = p.rows.filter((r) => r.oversoldShares > 1e-9);
    const warningEl = document.getElementById('oversold-warning');
    if (oversold.length > 0) {
      const detail = oversold.map((r) => `${escapeHtml(r.ticker)} (ขายเกิน ${fmtShares(r.oversoldShares)} หุ้น)`).join(', ');
      warningEl.textContent = `⚠️ พบรายการขายมากกว่าที่ซื้อไว้ในระบบ: ${detail} — แปลว่าอาจมีหุ้นที่ซื้อไว้ก่อนเริ่มบันทึกในนี้ ตัวเลขต้นทุนเฉลี่ยและกำไรที่ขายแล้วของตัวเหล่านี้จึงไม่ครบถ้วน แก้ไขได้ที่หน้ารายการธุรกรรม`;
      warningEl.style.display = 'block';
    } else {
      warningEl.style.display = 'none';
    }

    if (p.rows.length === 0) {
      body.innerHTML = '<tr><td colspan="10" class="empty">ยังไม่มีธุรกรรม — ไปที่หน้ารายการธุรกรรมเพื่อเพิ่ม</td></tr>';
    } else {
      body.innerHTML = p.rows.map((r) => {
        const isOpen = r.shares > 1e-9;
        const lastCell = !isOpen ? '-' : (r.price !== null ? fmtMoney(r.price) : 'N/A');
        const mvCell = !isOpen ? '-' : (r.marketValue !== null ? fmtMoney(r.marketValue) : 'N/A');
        const unrCell = !isOpen ? '-' : (r.unrealizedGain !== null ? fmtMoney(r.unrealizedGain) : 'N/A');
        const dayCell = !isOpen ? '-' : (r.dayChange !== null ? fmtMoney(r.dayChange) : 'N/A');
        const oversoldFlag = r.oversoldShares > 1e-9 ? ' <span title="มีการขายมากกว่าที่ซื้อไว้ในระบบ - ตัวเลขนี้อาจไม่ครบ">⚠️</span>' : '';
        // กำไรเป็น % ของต้นทุนตัวเอง - ตัวเลขที่บอกว่า "ตัวนี้ทำได้ดีแค่ไหน"
        // ซึ่งจำนวนเงินอย่างเดียวบอกไม่ได้ (กำไร $200 จากทุน $500 กับจาก
        // $10,000 คนละเรื่องกันเลย)
        const unrPct = isOpen && r.unrealizedGain !== null && r.costBasis > 1e-9
          ? (r.unrealizedGain / r.costBasis) * 100 : null;
        return `
        <tr>
          <td><strong>${escapeHtml(r.ticker)}</strong>${oversoldFlag}${r.stale ? ' <span title="ราคาช้า อาจไม่ใช่ล่าสุด">⚠️</span>' : ''}</td>
          <td class="num">${isOpen ? r.allocationPct.toFixed(1) + '%' : '-'}</td>
          <td class="num">${fmtShares(r.shares)}</td>
          <td class="num">${fmtMoney(r.avgCost)}</td>
          <td class="num">${lastCell}</td>
          <td class="num">${mvCell}</td>
          <td class="num ${isOpen && r.unrealizedGain !== null ? signClass(r.unrealizedGain) : ''}">${unrCell}</td>
          <td class="num ${unrPct === null ? '' : signClass(unrPct)}">${unrPct === null ? '-' : fmtPct(unrPct)}</td>
          <td class="num ${isOpen && r.dayChange !== null ? signClass(r.dayChange) : ''}">${dayCell}</td>
          <td class="num ${signClass(r.realizedPL)}">${fmtMoney(r.realizedPL)}</td>
        </tr>
      `;
      }).join('');
    }
  } catch (e) {
    body.innerHTML = '<tr><td colspan="10" class="empty">โหลดข้อมูลไม่สำเร็จ: ' + escapeHtml(e.message) + '</td></tr>';
    AppUI.setDataStatus('อัปเดตข้อมูลไม่สำเร็จ', 'error');
  }
}

render();
