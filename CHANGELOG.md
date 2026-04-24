# Wiltek Portal — Changelog

## Phase 2 — Role-Based Menu System (2026-04-24)

Implements SPEC §5 (page × role matrix + default landings) with DOM removal
of unauthorized menu items, plus branch scoping on the Customers page.

### Added
- **`permissions.js`** — new single source of truth for role → page matrix.
  Exposes `window.WP_PERMS`:
  - `rolePages` (SPEC §5.2 — 12 roles × 18 pages)
  - `roleLanding` (SPEC §5.1 default landing per role, with fallbacks for
    pages not yet built: owner/finance → `health`, hr → `expenses`,
    marketing → `customers`, w0x_mgr → `branches`)
  - `branchScopedRoles` + `branchScopedPages` + `ALL_BRANCHES`
  - Helpers: `hasAccess / getLandingPage / isBranchScopedRole /
    isBranchScopedPage / shouldLockBranchSelector / allowedBranches`
- `<script src="./permissions.js">` loaded right after `auditlog.js`.
- **Inventory page** — subtle amber notice bar at the top of `p-inventory`,
  only visible to `w01..w11_mgr`, informing them that current stock data
  is company-wide (branch-level snapshot is a Phase 4+ deliverable).
  Bilingual via existing i18n pattern.
- **`window._testRole(roleId)`** — dev-only helper for the owner to preview
  any role's menu without logging out. Prints a `console.warn` reminder.
  Remove before Phase 3.

### Changed
- **`Wiltek_MASTER.html` — `updateNav()`** rewritten: snapshots the full
  sidenav on first call, restores it on every subsequent call, then uses
  `.remove()` (not `display:none`) to delete menu items the current role
  cannot access (SPEC §5 requirement). Empty section headers (`.ns`) are
  also removed. Role landing comes from `WP_PERMS.getLandingPage()`.
- **`ROLE_DEFAULTS`** — `pages:[...]` field stripped from every entry.
  Page authorization now comes exclusively from `WP_PERMS.rolePages` via
  `getPerms()`. `ROLE_DEFAULTS` keeps only the orthogonal UI flags
  (`showNet`, `showGPpct`, `showCF`, `showBS`, `allBranches`,
  `canRefresh`, `canManageUsers`).
- **`getPerms(user)`** — reads `pages` from `WP_PERMS.rolePages[role]` and
  merges with per-user overrides from localStorage.
- **`renderCustomers()`** — branch-scoped users (w01..w11_mgr) now see:
  - Page header / KPIs computed from `CUST26.branches[branch]` YTD
    aggregates only.
  - Monthly walk-in chart and race-breakdown chart/table replaced with
    "branch data not available" placeholders (the underlying monthly and
    race-split data is company-wide in CUST26 — no per-branch version yet).
  - 27-month branch revenue chart filtered to a single line for that
    user's branch.
  Non-scoped roles (owner / finance / bi_consultant) continue to see the
  full 6-branch view unchanged.

### Fixed (vs Phase 1 permission matrix)
- `finance` no longer had implicit access to `branchhub` (demoted).
- `marketing` no longer had `branchhub` or `bistrat` (demoted).
- `hr` gained `action` (SPEC §5.2 allows it).
- `w01..w11_mgr` no longer had `biwh` (the BI Warehouse cockpit is
  unchanged — bi_consultant / warehouse only).

### Validation
- `node --check permissions.js` passes.
- All inline `<script>` blocks parse clean via `new Function()`.
- `<div>` open/close balance holds at 536/536 (one new `inv-scope-notice`
  wrapper).
- Simulated `updateNav()` against all 12 roles: rendered menu-item count
  matches `rolePages.length` exactly for every role; empty section headers
  correctly collapse (owner: 8 sections, finance: 7, bi_consultant: 6,
  warehouse: 5, hr/marketing: 4, branch managers: 6).

### Known gaps / next phase
- **Phase 4+: Branch-level inventory dataset**
  - Add per-branch SKU stock snapshot to Google Sheets data source.
  - Update `renderInventory` to filter by `userPerms.branch` for
    `w01..w11_mgr`.
  - Remove the "company-wide" notice (`#inv-scope-notice`) once branch
    data is live.
- **Phase 3: Remove `window._testRole()`** — it's a convenience for Jym
  to validate Phase 2 from the console; delete the helper + its
  registration block before Phase 3 opens.
- **Phase 4: Split CEO Cockpit from Financial Health** — owner's landing
  currently collapses both SPEC pages onto `health`.

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
