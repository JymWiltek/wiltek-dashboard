// ═══════════════════════════════════════════════════════════════════════
// Wiltek Portal — Audit Log (auditlog.js)
//
// SPEC §4.3. Records every meaningful security / decision event.
//
// Storage (in order of preference):
//   1. In-memory buffer (this session)
//   2. localStorage ring buffer of last 500 events
//   3. Flushed asynchronously to Apps Script (?type=audit_write) every 60s
//
// Events:
//   login_success, login_fail, login_locked, logout, session_expired,
//   page_view_sensitive, password_change, gtd_create, gtd_complete,
//   kill_decision, proposal_submit, proposal_approve, proposal_reject,
//   user_create, user_delete, permission_override
// ═══════════════════════════════════════════════════════════════════════
(function(){
  "use strict";
  const BUFFER_KEY   = 'wp_audit_buffer_v1';
  const MAX_BUFFER   = 500;
  const FLUSH_EVERY  = 60 * 1000;
  const FLUSH_URL    = '/api/proxy?type=audit_write';

  function now(){
    return new Date().toISOString();
  }

  function readBuffer(){
    try { const s = localStorage.getItem(BUFFER_KEY); return s ? JSON.parse(s) : []; }
    catch(e){ return []; }
  }
  function writeBuffer(arr){
    try { localStorage.setItem(BUFFER_KEY, JSON.stringify(arr.slice(-MAX_BUFFER))); }
    catch(e){ /* storage full — oldest dropped */ }
  }

  function log(action, target, details){
    const user = window.__wp_currentUser || { id:'(anonymous)', role:'(none)' };
    const entry = {
      t: now(),
      uid: user.id || '(anonymous)',
      role: user.role || '(none)',
      action: action,
      target: target || '',
      details: details || '',
      ua: (navigator.userAgent || '').slice(0, 120),
      // No IP — only reachable server-side during flush
    };
    const buf = readBuffer();
    buf.push(entry);
    writeBuffer(buf);
    try { console.info('[audit]', entry.t, entry.uid, entry.action, entry.target, entry.details); } catch(e){}
    return entry;
  }

  // Periodic flush to Apps Script. Silently drops on failure; data stays in
  // localStorage until next success. Apps Script endpoint added in Phase 3.
  async function flush(){
    const buf = readBuffer();
    if (!buf.length) return { ok:true, flushed:0 };
    try {
      const res = await fetch(FLUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ events: buf })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json().catch(()=>({ok:false}));
      if (j && j.ok) {
        writeBuffer([]); // drain on success
        return { ok:true, flushed: buf.length };
      }
      // Not yet deployed → keep buffer
      return { ok:false, pending: buf.length };
    } catch (e) {
      return { ok:false, error: e.message, pending: buf.length };
    }
  }

  // Auto-flush loop
  let flushTimer = null;
  function startAutoFlush(){
    if (flushTimer) return;
    flushTimer = setInterval(flush, FLUSH_EVERY);
  }
  function stopAutoFlush(){
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  }

  // Expose
  window.AuditLog = {
    log: log,
    flush: flush,
    read: readBuffer,
    clear: function(){ writeBuffer([]); },
    startAutoFlush: startAutoFlush,
    stopAutoFlush: stopAutoFlush
  };

  // Start auto-flush after DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startAutoFlush);
  } else {
    startAutoFlush();
  }
})();
