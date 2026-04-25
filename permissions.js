// ═══════════════════════════════════════════════════════════════════════
// Wiltek Portal — Role Permissions (permissions.js)
//
// SPEC §5.1 (landings) + §5.2 (page × role matrix) + §5.3 (menu layout).
// Single source of truth for Phase 2 menu filtering.
//
// Exposes window.WP_PERMS:
//   - rolePages                 : role → array of allowed page IDs
//   - roleLanding               : role → default landing page ID
//   - branchScopedRoles         : role IDs whose data scope is one branch
//   - branchScopedPages         : pages whose branch-selector must be locked
//   - ALL_BRANCHES              : every operating branch (W01..W11, no W04/W06/W08-W10)
//   - hasAccess(role, pageId)   : bool
//   - getLandingPage(role)      : page ID (fallback = first accessible page)
//   - isBranchScopedRole(role)  : bool
//   - isBranchScopedPage(id)    : bool
//   - shouldLockBranchSelector(role, pageId) : bool
//   - allowedBranches(role, userBranch)      : array of branch IDs
//
// Pages that SPEC lists but don't yet exist in the HTML (Phase 4/6/10 deliverables):
//   - "HR Dashboard"                       → hr falls back to `expenses`
//   - "Marketing Dashboard"                → marketing falls back to `customers`
//   - "Audit Log"                          → owner-only, page not built yet
//   - "CEO Cockpit"                        → SPEC distinguishes it from Financial
//                                            Health; current HTML collapses both
//                                            onto page id `health`. Phase 4 will split.
//
// Phase 3.1 built pages:
//   - "Branch Today" (`branchtoday`)       → live Floatation daily data.
//                                            Branch-scoped (dropdown locked to own branch).
//
// Wave 1 Step 1 added pages:
//   - "Today"     (`today`)     → universal landing for ALL roles (placeholder
//                                  until Wave 1 Step 2 dispatches per-role
//                                  widgets). Replaces the old per-role landings
//                                  (every roleLanding now points at 'today').
//   - "Settings"  (`settings`)  → admin tools (User Management, Refresh,
//                                  JSON snapshot). Owner only.
// ═══════════════════════════════════════════════════════════════════════
(function(){
  "use strict";

  // ── Role × page matrix (SPEC §5.2) ────────────────────────────────
  // Wave 1 Step 1 — every role gets `today` (universal L1 landing).
  // `settings` is owner-only. The original 18 page IDs gate Deep Dive
  // sub-tree visibility unchanged.
  const rolePages = {
    owner: [
      'today','settings',
      'health','pl','cashflow','gp','branches','balancesheet','expenses',
      'inventory','customers','tvb','bistrat','biwh','inv360',
      'gtd','proposals','action','valuation','branchhub','branchtoday','quicklinks'
    ],
    finance: [
      'today',
      'health','pl','cashflow','gp','branches','balancesheet','expenses',
      'inventory','customers','tvb','branchtoday',
      'gtd','proposals','action','quicklinks'
    ],
    bi_consultant: [
      'today',
      'inventory','customers','tvb','bistrat','biwh','inv360','branchtoday',
      'gtd','proposals','action','quicklinks'
    ],
    warehouse: [
      'today',
      'inventory','biwh','inv360',
      'gtd','proposals','action','quicklinks'
    ],
    hr: [
      'today',
      'expenses',
      'gtd','proposals','action','quicklinks'
    ],
    marketing: [
      'today',
      'customers','tvb',
      'gtd','proposals','action','quicklinks'
    ],
    // Branch managers share the same page set; data scoping is handled
    // via shouldLockBranchSelector() + Phase 4 server-side filters.
    w01_mgr: ['today','branchtoday','branches','inventory','customers','branchhub','gtd','proposals','action','quicklinks'],
    w02_mgr: ['today','branchtoday','branches','inventory','customers','branchhub','gtd','proposals','action','quicklinks'],
    w03_mgr: ['today','branchtoday','branches','inventory','customers','branchhub','gtd','proposals','action','quicklinks'],
    w05_mgr: ['today','branchtoday','branches','inventory','customers','branchhub','gtd','proposals','action','quicklinks'],
    w07_mgr: ['today','branchtoday','branches','inventory','customers','branchhub','gtd','proposals','action','quicklinks'],
    w11_mgr: ['today','branchtoday','branches','inventory','customers','branchhub','gtd','proposals','action','quicklinks'],
  };

  // ── Default landing page ───────────────────────────────────────────
  // Wave 1 Step 1: every role lands on Today first. Wave 1 Step 2 will
  // dispatch to per-role widgets *inside* Today. Until then, Today is a
  // single-line placeholder. The old per-role landings (Financial Health
  // for owner, Branch Today for managers, etc.) remain reachable via the
  // Deep Dive sub-tree.
  const roleLanding = {
    owner:         'today',
    finance:       'today',
    bi_consultant: 'today',
    warehouse:     'today',
    hr:            'today',
    marketing:     'today',
    w01_mgr:       'today',
    w02_mgr:       'today',
    w03_mgr:       'today',
    w05_mgr:       'today',
    w07_mgr:       'today',
    w11_mgr:       'today',
  };

  // ── Branch scoping (Jym's Phase 2 addendum) ────────────────────────
  // These roles see data from ONE branch only (their own).
  const branchScopedRoles = ['w01_mgr','w02_mgr','w03_mgr','w05_mgr','w07_mgr','w11_mgr'];

  // These pages contain a branch selector / dropdown that must be locked
  // (disabled, preselected to currentUser.branch) for branch-scoped users.
  const branchScopedPages = ['branches','inventory','customers','branchhub','branchtoday'];

  // Every operating branch. Matches the `branch` field in users.js.
  const ALL_BRANCHES = ['W01','W02','W03','W05','W07','W11'];

  // ── Helpers ────────────────────────────────────────────────────────
  function hasAccess(role, pageId){
    const allowed = rolePages[role];
    return Array.isArray(allowed) && allowed.indexOf(pageId) !== -1;
  }

  function getLandingPage(role){
    const landing = roleLanding[role];
    if (landing && hasAccess(role, landing)) return landing;
    const allowed = rolePages[role] || [];
    return allowed[0] || null;
  }

  function isBranchScopedRole(role){
    return branchScopedRoles.indexOf(role) !== -1;
  }

  function isBranchScopedPage(pageId){
    return branchScopedPages.indexOf(pageId) !== -1;
  }

  // True when the in-page branch selector on pageId MUST be locked to
  // the user's own branch (disabled + preselected).
  function shouldLockBranchSelector(role, pageId){
    return isBranchScopedRole(role) && isBranchScopedPage(pageId);
  }

  // Which branches is this role allowed to see data for?
  // - Non-scoped roles (owner, finance, …) → every branch.
  // - Branch-scoped roles (wXX_mgr)        → only their own branch.
  // Phase 2 caller: use this to filter dropdown options BEFORE disabling.
  function allowedBranches(role, userBranch){
    if (!isBranchScopedRole(role)) return ALL_BRANCHES.slice();
    return userBranch ? [userBranch] : [];
  }

  // ── Expose ────────────────────────────────────────────────────────
  window.WP_PERMS = {
    rolePages:                rolePages,
    roleLanding:              roleLanding,
    branchScopedRoles:        branchScopedRoles,
    branchScopedPages:        branchScopedPages,
    ALL_BRANCHES:             ALL_BRANCHES,
    hasAccess:                hasAccess,
    getLandingPage:           getLandingPage,
    isBranchScopedRole:       isBranchScopedRole,
    isBranchScopedPage:       isBranchScopedPage,
    shouldLockBranchSelector: shouldLockBranchSelector,
    allowedBranches:          allowedBranches,
  };
})();
