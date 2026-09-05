(async function () {
  const body = document.getElementById('div-body');
  const yearSelect = document.getElementById('div-year');
  let rows = [];
  const money = (n) => fmtMoney(Number(n) || 0);

  function renderYear(year) {
    const monthly = new Array(12).fill(0);
    rows.filter((r) => r.date.startsWith(String(year))).forEach((r) => { monthly[Number(r.date.slice(5, 7)) - 1] += r.net; });
    const max = Math.max(...monthly, 1);
    const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
    document.getElementById('div-chart').innerHTML = monthly.map((v, i) => `<div class="bar-item"><div class="bar-value">${v ? money(v) : '-'}</div><div class="bar-track"><div class="bar-fill" style="height:${Math.max(v ? 8 : 0, (v / max) * 100)}%"></div></div><div class="bar-label">${months[i]}</div></div>`).join('');
  }

  try {
    const raw = await Api.list();
    const normalized = await Currency.normalizeTransactions(raw);
    rows = normalized.transactions.filter((t) => t.action === 'Dividend').map((t) => ({ ...t, net: Math.max(0, (Number(t.amount) || 0) - (Number(t.tax) || 0)) })).sort((a,b) => b.date.localeCompare(a.date));
    const today = todayLocalISO();
    const ytd = rows.filter((r) => r.date.startsWith(today.slice(0,4))).reduce((s,r) => s+r.net,0);
    const since = new Date(); since.setFullYear(since.getFullYear()-1); const sinceStr = since.toISOString().slice(0,10);
    const ttm = rows.filter((r) => r.date >= sinceStr).reduce((s,r) => s+r.net,0);
    const holdings = Holdings.compute(normalized.transactions);
    const cost = holdings.reduce((s,h) => s + Math.max(0,h.costBasis),0);
    setTile('div-ytd', null, money(ytd)); setTile('div-ttm', null, money(ttm)); setTile('div-yoc', null, cost > 0 ? (ttm/cost*100).toFixed(2)+'%' : '-'); setTile('div-monthly', null, money(ttm/12));
    const years = [...new Set(rows.map((r) => r.date.slice(0,4)))]; if (!years.includes(today.slice(0,4))) years.unshift(today.slice(0,4));
    yearSelect.innerHTML = years.sort().reverse().map((y) => `<option>${y}</option>`).join(''); yearSelect.value = today.slice(0,4); renderYear(yearSelect.value);
    yearSelect.addEventListener('change', () => renderYear(yearSelect.value));
    body.innerHTML = rows.length ? rows.map((r) => `<tr><td>${escapeHtml(r.date)}</td><td><strong>${escapeHtml(r.ticker)}</strong></td><td class="num">${money(r.amount)}</td><td class="num neg">${money(r.tax)}</td><td class="num pos">${money(r.net)}</td><td>${escapeHtml(r.origCurrency || r.currency)}</td><td>${escapeHtml(r.note)}</td></tr>`).join('') : '<tr><td colspan="7" class="empty">ยังไม่มีรายการเงินปันผล — เพิ่มได้จากหน้ารายการธุรกรรม</td></tr>';
  } catch (e) { body.innerHTML = `<tr><td colspan="7" class="empty">โหลดข้อมูลไม่สำเร็จ: ${escapeHtml(e.message)}</td></tr>`; }
})();
