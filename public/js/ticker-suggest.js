// Ticker autocomplete for the Add/Edit Transaction form.
// Two sources merged: tickers already in the user's own ledger show
// instantly with zero latency (labelled "in your portfolio"), then
// /api/search (Yahoo symbol search, proxied server-side) is merged in after
// a short debounce. Typing is never blocked and the field always stays a
// free-text input - suggestions are a convenience, not a constraint.
const TickerSuggest = (() => {
  const DEBOUNCE_MS = 200;
  const MAX_ITEMS = 10;

  let input = null;
  let panel = null;
  let getLocal = () => [];
  let onPick = null;
  let items = [];
  let active = -1;
  let query = '';
  let debounceTimer = null;
  let seq = 0; // bumped on every keystroke; a response whose seq is stale is dropped
  let extraSuggestions = []; // caller-supplied pseudo-tickers, merged in alongside SYNTHETIC below

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

  function localMatches(q) {
    const up = q.toUpperCase();
    const seen = new Set();
    const out = [];
    for (const raw of getLocal()) {
      const sym = String(raw || '').toUpperCase();
      if (!sym || seen.has(sym)) continue;
      if (up && !sym.includes(up)) continue;
      seen.add(sym);
      out.push({ symbol: sym, name: '', exchange: '', owned: true });
      if (out.length >= MAX_ITEMS) break;
    }
    return out;
  }

  // Pseudo-tickers this app understands but that Yahoo's search can never
  // find (they aren't real Yahoo symbols) - surfaced locally, same
  // zero-latency treatment as the user's own ledger tickers.
  const SYNTHETIC = [
    { symbol: 'GOLD-THB', name: 'ทองคำแท่งไทย (ราคาสมาคมค้าทองคำ, หน่วยกรัม)', exchange: 'Thai Gold', keywords: ['gold', 'ทอง', 'ทองคำ'] },
  ];

  function syntheticMatches(q) {
    const up = q.toUpperCase();
    const lower = q.toLowerCase();
    return SYNTHETIC.concat(extraSuggestions)
      .filter((s) => s.symbol.includes(up) || s.keywords.some((k) => lower.includes(k) || k.includes(lower)))
      .map((s) => ({ symbol: s.symbol, name: s.name, exchange: s.exchange, owned: false }));
  }

  // Ledger tickers + synthetic tickers - the two sources that need no network
  // round trip, so they render on the same frame as the keystroke. `merge`
  // (below) already dedupes/enriches, so ledger wins if the same symbol
  // shows up in both (e.g. GOLD-THB already owned gets both the "in your
  // portfolio" badge AND the synthetic entry's name/exchange).
  function instantMatches(q) {
    return merge(localMatches(q), syntheticMatches(q));
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

  function openPanel() {
    panel.classList.add('show');
    input.setAttribute('aria-expanded', 'true');
  }

  function closePanel() {
    if (panel) { panel.classList.remove('show'); panel.innerHTML = ''; }
    if (input) { input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
    items = [];
    active = -1;
  }

  function syncActive() {
    const nodes = panel.querySelectorAll('.suggest-item');
    nodes.forEach((n, i) => {
      const on = i === active;
      n.classList.toggle('active', on);
      n.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (active >= 0 && nodes[active]) {
      input.setAttribute('aria-activedescendant', 'f-ticker-opt-' + active);
      nodes[active].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function render() {
    if (items.length === 0) { closePanel(); return; }
    panel.innerHTML = items.map((it, i) => `
      <div class="suggest-item" role="option" id="f-ticker-opt-${i}" data-idx="${i}" aria-selected="false">
        <span class="sym">${highlight(it.symbol, query)}</span>
        ${it.name ? `<span class="nm">${highlight(it.name, query)}</span>` : ''}
        ${it.exchange ? `<span class="ex">${escapeHtml(it.exchange)}</span>` : ''}
        ${it.owned ? '<span class="owned">ในพอร์ต</span>' : ''}
      </div>`).join('');
    openPanel();
    syncActive();
  }

  function move(delta) {
    if (items.length === 0) return;
    active = active < 0
      ? (delta > 0 ? 0 : items.length - 1)
      : (active + delta + items.length) % items.length;
    syncActive();
  }

  function pick(idx) {
    const it = items[idx];
    if (!it) return;
    input.value = it.symbol; // both sources already provide uppercase symbols
    closePanel();
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (onPick) onPick(it);
    input.focus();
  }

  async function fetchRemote(q) {
    const mine = ++seq;
    let remote = [];
    try {
      const body = await Api.search(q);
      remote = (body && Array.isArray(body.results)) ? body.results : [];
    } catch (e) {
      remote = []; // offline / server down: degrade to local-only, silently
    }
    if (mine !== seq) return; // a newer keystroke has already fired - drop this response
    items = merge(instantMatches(q), remote);
    if (active >= items.length) active = items.length - 1;
    render();
  }

  function onInput() {
    query = input.value.trim();
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (!query) { seq++; closePanel(); return; }
    // Local ledger + synthetic tickers paint on this very frame - no network in the path.
    items = instantMatches(query);
    active = -1;
    render();
    debounceTimer = setTimeout(() => fetchRemote(query), DEBOUNCE_MS);
  }

  function onKeyDown(e) {
    const open = panel.classList.contains('show');
    if (e.key === 'ArrowDown') { e.preventDefault(); if (open) move(1); else onInput(); return; }
    if (e.key === 'ArrowUp') { if (open) { e.preventDefault(); move(-1); } return; }
    if (e.key === 'Escape') { if (open) { e.preventDefault(); e.stopPropagation(); closePanel(); } return; }
    if (e.key === 'Enter') {
      // Only swallow Enter when a suggestion is actually highlighted -
      // otherwise Enter must keep submitting the form as it does today.
      if (open && active >= 0) { e.preventDefault(); pick(active); }
      else closePanel();
      return;
    }
    if (e.key === 'Tab') {
      if (open && active >= 0) pick(active); // accept, then let focus move on normally
      else closePanel();
    }
  }

  function attach(inputEl, opts) {
    input = inputEl;
    panel = document.getElementById(inputEl.getAttribute('aria-controls'));
    getLocal = (opts && opts.getLocal) || (() => []);
    onPick = (opts && opts.onPick) || null;
    extraSuggestions = (opts && opts.extraSuggestions) || [];

    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onKeyDown);
    input.addEventListener('focus', () => { if (input.value.trim()) onInput(); });
    input.addEventListener('blur', closePanel);

    // mousedown + preventDefault keeps focus on the input, so `blur` never
    // fires before the click registers - no blur-timeout hack needed.
    panel.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const row = e.target.closest('.suggest-item');
      if (row) pick(Number(row.dataset.idx));
    });
    panel.addEventListener('mousemove', (e) => {
      const row = e.target.closest('.suggest-item');
      if (!row) return;
      const idx = Number(row.dataset.idx);
      if (idx !== active) { active = idx; syncActive(); }
    });
  }

  return { attach, close: closePanel };
})();
