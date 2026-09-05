// Ticker autocomplete for the Add/Edit Transaction form.
// Two sources merged: tickers already in the user's own ledger show
// instantly with zero latency (labelled "in your portfolio"), then
// /api/search (Yahoo symbol search, proxied server-side) is merged in after
// a short debounce. Typing is never blocked and the field always stays a
// free-text input - suggestions are a convenience, not a constraint.
//
// รองรับหลายช่องในหน้าเดียวกัน (เช่น ช่อง Ticker ของฟอร์มซื้อขาย กับช่อง Ticker
// ของฟอร์มเงินปันผล) - สถานะทุกตัวเก็บแยกต่อ instance ไม่ใช่ตัวแปรกลางของโมดูล
// ถ้าใช้ตัวแปรกลาง การ attach ช่องที่สองจะไปทับช่องแรกจนช่องแรกใช้ไม่ได้
const TickerSuggest = (() => {
  const DEBOUNCE_MS = 200;
  const MAX_ITEMS = 10;

  const instances = [];
  let uid = 0;

  // Wraps the first case-insensitive occurrence of q in <mark>. Each of the
  // three slices is escaped separately so neither the remote payload nor the
  // user's own keystrokes can inject markup.
  function highlight(text, q) {
    const s = String(text || '');
    if (!q) return escapeHtml(s);
    const i = s.toUpperCase().indexOf(q.toUpperCase());
    if (i === -1) return escapeHtml(s);
    return escapeHtml(s.slice(0, i))
      + '<mark>' + escapeHtml(s.slice(i, i + q.length)) + '</mark>'
      + escapeHtml(s.slice(i + q.length));
  }

  // Pseudo-tickers this app understands but that Yahoo's search can never
  // find (they aren't real Yahoo symbols) - surfaced locally, same
  // zero-latency treatment as the user's own ledger tickers.
  const SYNTHETIC = [
    { symbol: 'GOLD-THB', name: 'ทองคำแท่งไทย (ราคาสมาคมค้าทองคำ, หน่วยกรัม)', exchange: 'Thai Gold', keywords: ['gold', 'ทอง', 'ทองคำ'] },
  ];

  function localMatches(st, q) {
    const up = q.toUpperCase();
    const seen = new Set();
    const out = [];
    for (const raw of st.getLocal()) {
      const sym = String(raw || '').toUpperCase();
      if (!sym || seen.has(sym)) continue;
      if (up && !sym.includes(up)) continue;
      seen.add(sym);
      out.push({ symbol: sym, name: '', exchange: '', owned: true });
      if (out.length >= MAX_ITEMS) break;
    }
    return out;
  }

  function syntheticMatches(st, q) {
    const up = q.toUpperCase();
    const lower = q.toLowerCase();
    return SYNTHETIC.concat(st.extraSuggestions)
      .filter((s) => s.symbol.includes(up) || s.keywords.some((k) => lower.includes(k) || k.includes(lower)))
      .map((s) => ({ symbol: s.symbol, name: s.name, exchange: s.exchange, owned: false }));
  }

  // Local (ledger) entries win: if Yahoo also knows that symbol, its name/
  // exchange fill in the blanks on the existing local entry instead of
  // creating a duplicate row.
  function merge(local, remote) {
    const out = local.slice();
    const bySymbol = new Map(out.map((r) => [r.symbol, r]));
    for (const r of remote) {
      const existing = bySymbol.get(r.symbol);
      if (existing) {
        if (!existing.name) existing.name = r.name;
        if (!existing.exchange) existing.exchange = r.exchange;
        continue;
      }
      if (out.length >= MAX_ITEMS) break;
      const entry = { symbol: r.symbol, name: r.name, exchange: r.exchange, owned: false };
      bySymbol.set(r.symbol, entry);
      out.push(entry);
    }
    return out;
  }

  // Ledger tickers + synthetic tickers - the two sources that need no network
  // round trip, so they render on the same frame as the keystroke. `merge`
  // already dedupes/enriches, so ledger wins if the same symbol shows up in
  // both (e.g. GOLD-THB already owned gets both the "in your portfolio" badge
  // AND the synthetic entry's name/exchange).
  function instantMatches(st, q) {
    return merge(localMatches(st, q), syntheticMatches(st, q));
  }

  function openPanel(st) {
    st.panel.classList.add('show');
    st.input.setAttribute('aria-expanded', 'true');
  }

  function closePanel(st) {
    st.panel.classList.remove('show');
    st.panel.innerHTML = '';
    st.input.setAttribute('aria-expanded', 'false');
    st.input.removeAttribute('aria-activedescendant');
    st.items = [];
    st.active = -1;
  }

  function syncActive(st) {
    const nodes = st.panel.querySelectorAll('.suggest-item');
    nodes.forEach((n, i) => {
      const on = i === st.active;
      n.classList.toggle('active', on);
      n.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (st.active >= 0 && nodes[st.active]) {
      st.input.setAttribute('aria-activedescendant', st.idPrefix + st.active);
      nodes[st.active].scrollIntoView({ block: 'nearest' });
    } else {
      st.input.removeAttribute('aria-activedescendant');
    }
  }

  function render(st) {
    if (st.items.length === 0) { closePanel(st); return; }
    // id ของแต่ละตัวเลือกต้องมี prefix ต่อ instance ไม่งั้นสองช่องในหน้าเดียวกัน
    // จะสร้าง id ซ้ำ และ aria-activedescendant จะชี้ผิดช่อง
    st.panel.innerHTML = st.items.map((it, i) => `
      <div class="suggest-item" role="option" id="${st.idPrefix}${i}" data-idx="${i}" aria-selected="false">
        <span class="sym">${highlight(it.symbol, st.query)}</span>
        ${it.name ? `<span class="nm">${highlight(it.name, st.query)}</span>` : ''}
        ${it.exchange ? `<span class="ex">${escapeHtml(it.exchange)}</span>` : ''}
        ${it.owned ? '<span class="owned">ในพอร์ต</span>' : ''}
      </div>`).join('');
    openPanel(st);
    syncActive(st);
  }

  function move(st, delta) {
    if (st.items.length === 0) return;
    st.active = st.active < 0
      ? (delta > 0 ? 0 : st.items.length - 1)
      : (st.active + delta + st.items.length) % st.items.length;
    syncActive(st);
  }

  function pick(st, idx) {
    const it = st.items[idx];
    if (!it) return;
    st.input.value = it.symbol; // both sources already provide uppercase symbols
    closePanel(st);
    st.input.dispatchEvent(new Event('change', { bubbles: true }));
    if (st.onPick) st.onPick(it);
    st.input.focus();
  }

  async function fetchRemote(st, q) {
    const mine = ++st.seq;
    let remote = [];
    try {
      const body = await Api.search(q);
      remote = (body && Array.isArray(body.results)) ? body.results : [];
    } catch (e) {
      remote = []; // offline / server down: degrade to local-only, silently
    }
    if (mine !== st.seq) return; // a newer keystroke has already fired - drop this response
    st.items = merge(instantMatches(st, q), remote);
    if (st.active >= st.items.length) st.active = st.items.length - 1;
    render(st);
  }

  function onInput(st) {
    st.query = st.input.value.trim();
    if (st.debounceTimer) { clearTimeout(st.debounceTimer); st.debounceTimer = null; }
    if (!st.query) { st.seq++; closePanel(st); return; }
    // Local ledger + synthetic tickers paint on this very frame - no network in the path.
    st.items = instantMatches(st, st.query);
    st.active = -1;
    render(st);
    st.debounceTimer = setTimeout(() => fetchRemote(st, st.query), DEBOUNCE_MS);
  }

  function onKeyDown(st, e) {
    const open = st.panel.classList.contains('show');
    if (e.key === 'ArrowDown') { e.preventDefault(); if (open) move(st, 1); else onInput(st); return; }
    if (e.key === 'ArrowUp') { if (open) { e.preventDefault(); move(st, -1); } return; }
    if (e.key === 'Escape') { if (open) { e.preventDefault(); e.stopPropagation(); closePanel(st); } return; }
    if (e.key === 'Enter') {
      // Only swallow Enter when a suggestion is actually highlighted -
      // otherwise Enter must keep submitting the form as it does today.
      if (open && st.active >= 0) { e.preventDefault(); pick(st, st.active); }
      else closePanel(st);
      return;
    }
    if (e.key === 'Tab') {
      if (open && st.active >= 0) pick(st, st.active); // accept, then let focus move on normally
      else closePanel(st);
    }
  }

  // คืน instance ที่ผูกไว้ หรือ null ถ้าผูกไม่ได้ - หน้าเพจที่ไม่มีช่องนั้น หรือ
  // ช่องที่ลืมใส่ aria-controls ชี้ไปยัง .suggest-panel ต้องไม่ทำให้ทั้งสคริปต์
  // ของหน้าตายไปด้วย (autocomplete เป็นของอำนวยความสะดวก ไม่ใช่ของจำเป็น)
  function attach(inputEl, opts) {
    if (!inputEl) return null;
    const panel = document.getElementById(inputEl.getAttribute('aria-controls') || '');
    if (!panel) return null;

    const st = {
      input: inputEl,
      panel,
      getLocal: (opts && opts.getLocal) || (() => []),
      onPick: (opts && opts.onPick) || null,
      extraSuggestions: (opts && opts.extraSuggestions) || [],
      items: [],
      active: -1,
      query: '',
      debounceTimer: null,
      seq: 0, // bumped on every keystroke; a response whose seq is stale is dropped
      idPrefix: 'ts' + (++uid) + '-opt-',
    };
    instances.push(st);

    inputEl.addEventListener('input', () => onInput(st));
    inputEl.addEventListener('keydown', (e) => onKeyDown(st, e));
    inputEl.addEventListener('focus', () => { if (st.input.value.trim()) onInput(st); });
    inputEl.addEventListener('blur', () => closePanel(st));

    // mousedown + preventDefault keeps focus on the input, so `blur` never
    // fires before the click registers - no blur-timeout hack needed.
    panel.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const row = e.target.closest('.suggest-item');
      if (row) pick(st, Number(row.dataset.idx));
    });
    panel.addEventListener('mousemove', (e) => {
      const row = e.target.closest('.suggest-item');
      if (!row) return;
      const idx = Number(row.dataset.idx);
      if (idx !== st.active) { st.active = idx; syncActive(st); }
    });

    return st;
  }

  // ปิดทุกช่องพร้อมกัน - ผู้เรียก (เช่นตอนปิด modal) ไม่ต้องรู้ว่ามีกี่ช่อง
  function closeAll() {
    instances.forEach(closePanel);
  }

  return { attach, close: closeAll };
})();
