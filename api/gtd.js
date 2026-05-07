// ═══════════════════════════════════════════════════════════════════════
// Wiltek Portal — GTD persistence (Vercel serverless)
//
// V1.5: Cross-device sync for the GTD dashboard. Storage = a single GitHub
// Gist file (gtd-data.json). Reads via the public Gist URL (no auth, no
// rate limit beyond GitHub's CDN). Writes via GitHub API PATCH (requires
// GH_GIST_TOKEN env var with `gist` scope).
//
// Frontend POST shape:
//   { branch: 'W05', store: { '<branch>::task::<id>::<month>': 'Done', ... } }
//
// Backend merge strategy (per-branch namespace + global target lane):
//   - Keys starting with `${branch}::` overwrite that branch's slice
//   - Keys starting with `target::` (no branch prefix) belong to a global
//     target lane that any logged-in user can read; only Owner role should
//     edit (enforced client-side; this endpoint trusts the caller).
//
// On read failure (no token / Gist not configured), returns
// { ok: false, reason: 'no-store' } so the frontend falls back to localStorage.
//
// ENV VARS (set in Vercel dashboard):
//   GH_GIST_ID       — id of the gist hosting gtd-data.json
//   GH_GIST_TOKEN    — personal access token with `gist` scope
//   (Both optional. If missing, endpoint is read-only fallback to {}.)
// ═══════════════════════════════════════════════════════════════════════

const FILE = 'gtd-data.json';

async function readGist() {
  const id = process.env.GH_GIST_ID;
  if (!id) return { ok: false, reason: 'no-gist-id', store: {} };
  // Public Gist read — no auth needed. Cache-bust on every call.
  const r = await fetch(`https://api.github.com/gists/${id}`, {
    headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'wiltek-gtd' },
    cache: 'no-store',
  });
  if (!r.ok) return { ok: false, reason: `gist HTTP ${r.status}`, store: {} };
  const j = await r.json();
  const f = (j.files || {})[FILE];
  if (!f || !f.content) return { ok: true, store: {} };
  try {
    const obj = JSON.parse(f.content);
    return { ok: true, store: obj.store || obj || {} };
  } catch (e) {
    return { ok: false, reason: 'invalid JSON in gist', store: {} };
  }
}

async function writeGist(mergedStore) {
  const id    = process.env.GH_GIST_ID;
  const token = process.env.GH_GIST_TOKEN;
  if (!id || !token) {
    return { ok: false, reason: !id ? 'no-gist-id' : 'no-gist-token' };
  }
  const body = {
    files: {
      [FILE]: {
        content: JSON.stringify({ store: mergedStore, updated_at: new Date().toISOString() }, null, 2),
      },
    },
  };
  const r = await fetch(`https://api.github.com/gists/${id}`, {
    method: 'PATCH',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'User-Agent': 'wiltek-gtd',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text();
    return { ok: false, reason: `gist PATCH HTTP ${r.status}: ${txt.slice(0, 120)}` };
  }
  return { ok: true };
}

// Merge strategy: incoming store keys overwrite existing ones for the SAME
// branch namespace. Other branches' keys + target:: keys are preserved.
function mergeStore(existing, incoming, branch) {
  const out = { ...existing };
  for (const k of Object.keys(incoming || {})) {
    // Allow target:: lane (global) and `<branch>::*` (branch-scoped).
    if (k.startsWith('target::') || k.startsWith(branch + '::')) {
      out[k] = incoming[k];
    }
    // Cross-branch keys in incoming payload are silently ignored
    // (a w05_mgr's payload should never contain W02:: keys; defensive).
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (req.method === 'GET') {
    const { ok, store, reason } = await readGist();
    res.status(200).json({ ok, store: store || {}, reason });
    return;
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { res.status(400).json({ ok: false, error: 'invalid JSON body' }); return; }
    }
    const branch = (body && body.branch) || '';
    const incoming = (body && body.store) || {};
    if (!branch) { res.status(400).json({ ok: false, error: 'branch required' }); return; }

    // Read existing, merge, write back.
    const cur = await readGist();
    const merged = mergeStore(cur.store || {}, incoming, branch);
    const wr = await writeGist(merged);
    if (!wr.ok) {
      res.status(200).json({ ok: false, reason: wr.reason, store: merged });
      return;
    }
    res.status(200).json({ ok: true, store: merged });
    return;
  }

  res.status(405).json({ ok: false, error: 'GET or POST only' });
}
