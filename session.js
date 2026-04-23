// ═══════════════════════════════════════════════════════════════════════
// Wiltek Portal — Session & Login Lockout (session.js)
//
// SPEC §4.1 + §4.2.
//
// Exposes window.WP_SESSION:
//   - start(user)           : begin session (after successful auth)
//   - end()                 : terminate (logout / expired)
//   - get()                 : current session object or null
//   - touch()               : bump lastActivity (called on every UI event)
//   - onExpire(cb)          : register expiry callback
//
//   - recordFail(uid)       : increment failed-login counter
//   - recordSuccess(uid)    : reset failed-login counter
//   - lockStatus(uid)       : { locked:bool, remainingMs:number, tries:number }
//
// Session is stored in sessionStorage (cleared on browser close).
// Lockout state is stored in localStorage so it persists across tabs/restarts.
// ═══════════════════════════════════════════════════════════════════════
(function(){
  "use strict";

  const SESSION_KEY     = 'wp_session_v1';
  const LOCK_KEY_PREFIX = 'wp_lock_';            // wp_lock_<uid>
  const IDLE_LIMIT_MS   = 30 * 60 * 1000;        // 30 min
  const MAX_FAILS       = 5;
  const LOCK_DURATION   = 15 * 60 * 1000;        // 15 min

  let expireTimer = null;
  let expireCallbacks = [];

  function now(){ return Date.now(); }

  // ── Session management ─────────────────────────────────────────────
  function getSession(){
    try { const s = sessionStorage.getItem(SESSION_KEY); return s ? JSON.parse(s) : null; }
    catch(e){ return null; }
  }
  function writeSession(s){
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
    catch(e){ /* ignore */ }
  }
  function clearSession(){
    try { sessionStorage.removeItem(SESSION_KEY); } catch(e){}
  }

  function start(user){
    const s = {
      userId: user.id,
      role: user.role,
      branch: user.branch || null,
      name: user.name || user.id,
      loginTime: now(),
      lastActivity: now(),
      ipRegion: 'local' // server-side stamping happens at Apps Script flush
    };
    writeSession(s);
    scheduleExpire();
    return s;
  }
  function end(){
    clearSession();
    cancelExpire();
  }
  function touch(){
    const s = getSession();
    if (!s) return null;
    s.lastActivity = now();
    writeSession(s);
    scheduleExpire();
    return s;
  }

  function scheduleExpire(){
    cancelExpire();
    expireTimer = setTimeout(checkExpire, IDLE_LIMIT_MS + 1000);
  }
  function cancelExpire(){
    if (expireTimer) { clearTimeout(expireTimer); expireTimer = null; }
  }
  function checkExpire(){
    const s = getSession();
    if (!s) return;
    const idle = now() - (s.lastActivity || 0);
    if (idle >= IDLE_LIMIT_MS) {
      clearSession();
      expireCallbacks.forEach(cb => { try { cb(); } catch(e){} });
    } else {
      expireTimer = setTimeout(checkExpire, IDLE_LIMIT_MS - idle + 1000);
    }
  }

  function onExpire(cb){
    if (typeof cb === 'function') expireCallbacks.push(cb);
  }

  // ── Lockout tracking ───────────────────────────────────────────────
  function lockKey(uid){ return LOCK_KEY_PREFIX + String(uid).toLowerCase(); }

  function readLock(uid){
    try {
      const s = localStorage.getItem(lockKey(uid));
      return s ? JSON.parse(s) : { tries: 0, lockedUntil: 0 };
    } catch(e){ return { tries: 0, lockedUntil: 0 }; }
  }
  function writeLock(uid, lock){
    try { localStorage.setItem(lockKey(uid), JSON.stringify(lock)); }
    catch(e){}
  }
  function clearLock(uid){
    try { localStorage.removeItem(lockKey(uid)); } catch(e){}
  }

  function lockStatus(uid){
    if (!uid) return { locked:false, remainingMs:0, tries:0 };
    const l = readLock(uid);
    const remaining = Math.max(0, (l.lockedUntil || 0) - now());
    return {
      locked: remaining > 0,
      remainingMs: remaining,
      tries: l.tries || 0
    };
  }

  function recordFail(uid){
    if (!uid) return { tries:0, lockedUntil:0 };
    const l = readLock(uid);
    l.tries = (l.tries || 0) + 1;
    if (l.tries >= MAX_FAILS) {
      l.lockedUntil = now() + LOCK_DURATION;
      l.tries = MAX_FAILS; // cap so display doesn't keep incrementing while locked
    }
    writeLock(uid, l);
    return l;
  }

  function recordSuccess(uid){
    if (!uid) return;
    clearLock(uid);
  }

  // ── Activity listeners ─────────────────────────────────────────────
  // Touch session on any user interaction, so idle timer resets.
  function attachActivityListeners(){
    const handler = function(){
      if (getSession()) touch();
    };
    ['mousedown','keydown','touchstart','scroll'].forEach(ev => {
      document.addEventListener(ev, handler, { passive:true });
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachActivityListeners);
  } else {
    attachActivityListeners();
  }

  // Restore timer if a session already exists from a prior page load
  if (getSession()) scheduleExpire();

  // ── Expose ─────────────────────────────────────────────────────────
  window.WP_SESSION = {
    start: start,
    end: end,
    get: getSession,
    touch: touch,
    onExpire: onExpire,
    recordFail: recordFail,
    recordSuccess: recordSuccess,
    lockStatus: lockStatus,
    IDLE_LIMIT_MS: IDLE_LIMIT_MS,
    MAX_FAILS: MAX_FAILS,
    LOCK_DURATION: LOCK_DURATION
  };

  // ── Helpers on crypto ──────────────────────────────────────────────
  // SHA-256 helper exposed for the login flow. Browsers require HTTPS or
  // localhost for crypto.subtle.
  async function sha256Hex(text){
    const buf = new TextEncoder().encode(text);
    const hashBuf = await crypto.subtle.digest('SHA-256', buf);
    const bytes = new Uint8Array(hashBuf);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  }
  window.WP_SESSION.sha256Hex = sha256Hex;
})();
