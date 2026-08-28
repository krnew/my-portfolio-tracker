// Minimal RFC4180-ish CSV parser/writer, no dependencies.
const CSVUtil = (() => {
  function parse(text) {
    const rows = [];
    let field = '', row = [], inQuotes = false;
    const pushField = () => { row.push(field); field = ''; };
    const pushRow = () => { rows.push(row); row = []; };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ',') pushField();
        else if (c === '\r') { /* skip */ }
        else if (c === '\n') { pushField(); pushRow(); }
        else field += c;
      }
    }
    if (field.length > 0 || row.length > 0) { pushField(); pushRow(); }
    return rows.filter((r) => !(r.length === 1 && r[0] === ''));
  }

  function toObjects(text) {
    const rows = parse(text);
    if (rows.length === 0) return { headers: [], objects: [] };
    const headers = rows[0].map((h) => h.trim());
    const objects = rows.slice(1).map((r) => {
      const obj = {};
      headers.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx] : ''; });
      return obj;
    });
    return { headers, objects };
  }

  return { parse, toObjects };
})();
