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
//                                            Default landing for w01..w11_mgr.
//                                            Branch-scoped (dropdown locked to own branch).
// ═══════════════════════════════════════════════════════════════════════
(function(){
  "use strict";

  // ── Role × page matrix (SPEC §5.2) ────────────────────────────────
  const rolePages = {
    owner: [
      'health','pl','cashflow','gp','branches','balancesheet','expenses',
      'inventory','customers','bistrat','biwh','inv360',
      'gtd','proposals','action','valuation','branchhub','branchtoday','quicklinks'
    ],
    finance: [
      'health','pl','cashflow','gp','branches','balancesheet','expenses',
      'inventory','customers','branchtoday',
      'gtd','proposals','action','quicklinks'
    ],
    bi_consultant: [
      'inventory','customers','bistrat','biwh','inv360','branchtoday',
      'gtd','proposals','action','quicklinks'
    ],
    warehouse: [
      'inventory','biwh','inv360',
      'gtd','proposals','action','quicklinks'
    ],
    hr: [
      'expenses',
      'gtd','proposals','action','quicklinks'
    ],
    marketing: [
      'customers',
      'gtd','proposals','action','quicklinks'
    ],
    // Branch managers share the same page set; data scoping is handled
    // via shouldLockBranchSelector() + Phase 4 server-side filters.
    w01_mgr: ['branchtoday','branches','inventory','customers','branchhub','gtd','proposals','action','quicklinks'],
    w02_mgr: ['branchtoday','branches','inventory','customers','branchhub','gtd','proposals','action','quicklinks'],
    w03_mgr: ['branchtoday','branches','inventory','customers','branchhub','gtd','proposals','action','quicklinks'],
    w05_mgr: ['branchtoday','branches','inventory','customers','branchhub','gtd','proposals','action','quicklinks'],
    w07_mgr: ['branchtoday','branches','inventory','customers','branchhub','gtd','proposals','action','quicklinks'],
    w11_mgr: ['branchtoday','branches','inventory','customers','branchhub','gtd','proposals','action','quicklinks'],
  };

  // ── Default landing page (SPEC §5.1, with Phase 2 fallbacks) ───────
  const roleLanding = {
    owner:         'health',   // "CEO Cockpit" unbuilt → collapses onto Financial Health
    finance:       'health',
    bi_consultant: 'bistrat',
    warehouse:     'biwh',
    hr:            'expenses', // "HR Dashboard" unbuilt → fallback
    marketing:     'customers',// "Customer Intel" is the customers page
    w01_mgr:       'branchtoday', // Phase 3.1 — live Floatation dashboard
    w02_mgr:       'branchtoday',
    w03_mgr:       'branchtoday',
    w05_mgr:       'branchtoday',
    w07_mgr:       'branchtoday',
    w11_mgr:       'branchtoday',
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
