// ═══════════════════════════════════════════════════════════════════════
// Wiltek Portal — API proxy (Vercel serverless)
//
// Forwards browser requests → Apps Script Web App, injecting the API key
// server-side so the key never ships to the browser (SPEC §4.1 / §13).
//
// BOTH secrets live only in Vercel env (Project → Settings → Environment
// Variables → Production + Preview + Development). They are never written
// to git. If either is missing, the proxy returns 500 instead of silently
// falling back — this is the safer failure mode.
//
//   WTK_APPS_SCRIPT_URL  — full Apps Script /exec URL
//   WTK_API_KEY          — current API key (rotate whenever a key burns)
//
// Browser callers use:
//   GET  /api/proxy?type=all                  → full payload
//   GET  /api/proxy?type=<whatever>&...       → any other type the Apps Script supports
//   POST /api/proxy?type=audit_write          → body forwarded verbatim (SPEC §4.3 audit flush)
// ═══════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  // CORS — Vercel + GitHub Pages both hit this, keep it permissive.
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const BASE = process.env.WTK_APPS_SCRIPT_URL;
  const KEY  = process.env.WTK_API_KEY;

  if (!BASE) {
    res.status(500).json({ ok: false, error: 'WTK_APPS_SCRIPT_URL not configured on server' });
    return;
  }
  if (!KEY) {
    res.status(500).json({ ok: false, error: 'WTK_API_KEY not configured on server' });
    return;
  }

  // Pass-through query; default to type=all if not provided
  const inType = (req.query && req.query.type) || 'all';
  // Strip "key" from client query — we always inject our own.
  const extra = Object.entries(req.query || {})
    .filter(([k]) => k !== 'type' && k !== 'key')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const target = `${BASE}?type=${encodeURIComponent(inType)}&key=${encodeURIComponent(KEY)}${extra ? '&' + extra : ''}`;

  try {
    const init = { redirect: 'follow', method: req.method || 'GET' };
    if (req.method === 'POST') {
      init.headers = { 'Content-Type': 'application/json' };
      init.body    = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    }
    const r    = await fetch(target, init);
    const text = await r.text();

    // Apps Script returns JSON for /exec; if HTML leaks through, surface it verbatim
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    res.status(r.status).send(text);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
}
