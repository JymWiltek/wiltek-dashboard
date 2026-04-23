# Wiltek Portal — Changelog

## Phase 1 — Security Foundation (2026-04-23)

Implements SPEC §4 (security) and §5.1 (12-role RBAC).

### Added
- **`users.js`** — external user credentials. 12 users per SPEC §5.1 with
  SHA-256(salt + password) hashes, hex-encoded. Never commits plaintext passwords.
- **`session.js`** — `window.WP_SESSION` API:
  - `start / end / get / touch / onExpire` — 30-min idle timeout (sessionStorage,
    cleared on browser close)
  - `recordFail / recordSuccess / lockStatus` — 5-fails-in-a-row → 15-min lockout
    (localStorage, survives tab close)
  - `sha256Hex` — crypto.subtle-backed hashing helper used by the login flow
  - Auto-attached activity listeners on `mousedown / keydown / touchstart / scroll`
    keep the idle timer honest.
- **`auditlog.js`** — `window.AuditLog` ring buffer (500 events) with 60-s
  flush loop to `/api/proxy?type=audit_write`. Captures `login_success`,
  `login_fail`, `login_locked`, `logout`, `session_expired`, `gtd_migrate`, etc.
- `<script src="./users.js|session.js|auditlog.js">` injected into
  `Wiltek_MASTER.html` immediately after Chart.js so the login form can call
  them synchronously.

### Changed
- **`Wiltek_MASTER.html` — login flow** (`checkPw`): async, computes
  `sha256Hex(salt + pw)`, compares to `window.WP_USERS[i].hash`, honors lockout,
  writes audit events on every success / fail / locked attempt.
- **Role model** — consolidated 10-role legacy set → 12 SPEC roles:
  | was             | now              |
  |-----------------|------------------|
  | admin           | **owner**        |
  | cfo             | **finance**      |
  | ceo             | owner / finance (case-by-case) |
  | director        | _retired_        |
  | sales_mgr       | _retired_        |
  | branch_mgr      | **w01_mgr … w11_mgr** (per branch) |
  | employee        | _retired_        |
  | hr / warehouse / marketing | unchanged |
  | _(new)_         | **bi_consultant** |
  - `ROLE_DEFAULTS`, `primaryNav`, `roleLanding`, `ALL_ROLES`, and all
    `currentUser.role === 'admin'` guards updated throughout.
  - Proposal routing: T1 approvable by any manager; T2/T3 (>RM500)
    now restricted to `owner` or `finance` (was `ceo / cfo / admin`).
- **`api/proxy.js`** — previously hardcoded Apps Script URL + legacy API
  key are gone. Now reads `process.env.WTK_APPS_SCRIPT_URL` and
  `process.env.WTK_API_KEY`; returns HTTP 500 if either is missing (no
  silent fallback). Adds CORS preflight, strips client-supplied `key`
  parameter defensively, forwards POST body for audit-log flush.
- **GTD data migration** — `gtdLoad()` now calls `gtdMigrate()` which
  adds default `{assignee: 'owner', source: 'legacy', linked_entities: null,
  proof: null, created_at: (preserved from existing record), priority: 'medium'}`
  to every legacy record on read. One-time audit event `gtd_migrate` is
  emitted the first time a given browser migrates its cached list.
- **User Management panel** — password field replaced with read-only
  "hashed · edit users.js" label; Add User button now directs the owner to
  edit `users.js` instead of writing a plaintext password into localStorage.

### Removed
- Dead `GD_API_URL` and `GD_API_KEY` constants from the legacy HTML.
  All data fetches already went through `/api/proxy`; the constants were
  never read. Their removal also evicts the burned legacy API key string
  from the client bundle.
- Plaintext passwords in `DEFAULT_USERS`. The inline list is now populated
  from the public view of `window.WP_USERS` (id / role / branch / name only —
  no salt or hash).
- `saveUsers()` is now a no-op stub (user creation moved to editing
  `users.js` and redeploying).

### Operational
- **Apps Script API key** is rotated on every burn event; the current
  value lives only in Vercel env (`WTK_API_KEY`) and in the Apps Script
  project (`Code.gs` `API_SECRET` constant). Never committed.
- **Apps Script Web App URL** lives only in Vercel env
  (`WTK_APPS_SCRIPT_URL`). Never committed.
- To deploy Phase 1: set both env vars on Vercel → Project → Settings →
  Environment Variables (Production + Preview + Development), then push
  this branch. First request will hit Apps Script through the proxy.
- **Initial passwords** (rotate after first login): see header comment at
  the top of `users.js`. Change by regenerating the hash with
  `SHA-256(salt + newpassword)` and pasting back into `users.js`.

### Validation
- `node --check` passes on `Wiltek_MASTER.html` inline scripts, `users.js`,
  `session.js`, `auditlog.js`, `api/proxy.js`.
- 535 `<div>` opens balanced against 535 closes.
- All 12 users' hashes verified with `openssl`-equivalent Node `crypto`.
- Lockout triggers at exactly 5 fails; `recordSuccess` clears.
- Session `start / touch / get / end` round-trips cleanly.
- AuditLog persists 3/3 test events to localStorage.

### Not in this phase (deferred)
- `/api/proxy?type=audit_write` server handler (Phase 3 / Apps Script
  update). Until deployed, audit events stay in the browser's localStorage
  and auto-retry every 60 s — zero data loss.
- Password reset UI (Phase 2).
- Server-side session revocation list (Phase 3).
