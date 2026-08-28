const Api = (() => {
  async function handle(res) {
    let body = null;
    try { body = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) throw new Error((body && body.error) || ('HTTP ' + res.status));
    return body;
  }

  return {
    list: () => fetch('/api/transactions').then(handle),
    create: (data) => fetch('/api/transactions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    }).then(handle),
    update: (id, data) => fetch('/api/transactions/' + encodeURIComponent(id), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    }).then(handle),
    remove: (id) => fetch('/api/transactions/' + encodeURIComponent(id), { method: 'DELETE' }).then(handle),
    bulkImport: (rows) => fetch('/api/transactions/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows }),
    }).then(handle),
    search: (q) => fetch('/api/search?q=' + encodeURIComponent(q)).then(handle),
    fxHistory: (currency, start) => fetch('/api/fx-history?currency=' + encodeURIComponent(currency) + '&start=' + encodeURIComponent(start)).then(handle),
  };
})();
