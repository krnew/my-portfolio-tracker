const AppUI = (() => {
  const PRIVACY_KEY = 'portfolio.privacy';

  function initPrivacy() {
    const button = document.getElementById('privacy-toggle');
    if (!button) return;

    let enabled = false;
    try { enabled = localStorage.getItem(PRIVACY_KEY) === '1'; } catch (e) { /* storage unavailable */ }

    function paint() {
      document.body.classList.toggle('privacy-on', enabled);
      button.textContent = enabled ? '◉ แสดงยอดเงิน' : '◌ ซ่อนยอดเงิน';
      button.setAttribute('aria-pressed', String(enabled));
      button.setAttribute('title', enabled ? 'แสดงตัวเลขทางการเงิน' : 'ซ่อนตัวเลขทางการเงิน');
    }

    button.addEventListener('click', () => {
      enabled = !enabled;
      try { localStorage.setItem(PRIVACY_KEY, enabled ? '1' : '0'); } catch (e) { /* storage unavailable */ }
      paint();
    });
    paint();
  }

  function initRefresh() {
    document.querySelectorAll('[data-refresh]').forEach((button) => {
      button.addEventListener('click', () => {
        button.disabled = true;
        button.textContent = 'กำลังอัปเดต…';
        const url = new URL(location.href);
        url.searchParams.set('refresh', String(Date.now()));
        location.replace(url.pathname + url.search);
      });
    });
  }

  function setDataStatus(message, state) {
    const el = document.getElementById('data-status-text');
    if (!el) return;
    el.textContent = message;
    el.className = 'data-status-text' + (state ? ' is-' + state : '');
  }

  function updatePriceStatus(prices, fx) {
    const entries = Object.values(prices || {}).filter((p) => p && !p.error);
    const failures = Object.values(prices || {}).filter((p) => p && p.error).length;
    const stale = entries.some((p) => p.stale) || !!(fx && fx.stale);
    const timestamps = entries.map((p) => Number(p.fetchedAt)).filter(Number.isFinite);

    if (entries.length === 0) {
      setDataStatus(failures ? 'ดึงราคาล่าสุดไม่สำเร็จ' : 'ยังไม่มีสินทรัพย์ที่ต้องอัปเดตราคา', failures ? 'error' : 'ready');
      return;
    }

    const time = timestamps.length
      ? new Date(Math.max(...timestamps)).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
      : 'เมื่อสักครู่';
    const suffix = failures ? ` · ขาด ${failures} รายการ` : '';
    setDataStatus(
      stale ? `ใช้ราคาสำรองจาก ${time}${suffix}` : `ราคาอัปเดตล่าสุด ${time}${suffix}`,
      stale || failures ? 'warning' : 'ready',
    );
  }

  initPrivacy();
  initRefresh();
  return { setDataStatus, updatePriceStatus };
})();
