/**
 * Wiltek Portal — initial credentials.
 * Verified by hashing salt + password against users.js.
 * If passwords ever rotate, regen via tools/set-password.js and update here.
 */
export const CREDENTIALS = [
  { id: 'owner',     pw: 'Owner@2026',     role: 'owner',         branch: null  },
  { id: 'finance',   pw: 'Finance@2026',   role: 'finance',       branch: null  },
  { id: 'bi',        pw: 'BI@2026',        role: 'bi_consultant', branch: null  },
  { id: 'warehouse', pw: 'Warehouse@2026', role: 'warehouse',     branch: null  },
  { id: 'hr',        pw: 'HR@2026',        role: 'hr',            branch: null  },
  { id: 'marketing', pw: 'Marketing@2026', role: 'marketing',     branch: null  },
  { id: 'w01_mgr',   pw: 'W01@2026',       role: 'w01_mgr',       branch: 'W01' },
  { id: 'w02_mgr',   pw: 'W02@2026',       role: 'w02_mgr',       branch: 'W02' },
  { id: 'w03_mgr',   pw: 'W03@2026',       role: 'w03_mgr',       branch: 'W03' },
  { id: 'w05_mgr',   pw: 'W05@2026',       role: 'w05_mgr',       branch: 'W05' },
  { id: 'w07_mgr',   pw: 'W07@2026',       role: 'w07_mgr',       branch: 'W07' },
  { id: 'w11_mgr',   pw: 'W11@2026',       role: 'w11_mgr',       branch: 'W11' },
] as const;

/**
 * Page id → readable label (kept loose; the spec asserts the page becomes
 * .active after nav() rather than matching label text).
 */
export const ALL_PAGES = [
  'today', 'settings',
  'health', 'pl', 'cashflow', 'gp', 'branches', 'balancesheet', 'expenses',
  'inventory', 'customers', 'bistrat', 'biwh', 'inv360',
  'gtd', 'proposals', 'action', 'valuation', 'branchhub', 'branchtoday', 'quicklinks',
] as const;

export type PageId = typeof ALL_PAGES[number];

export const VIEWPORTS = [
  { name: 'mobile',  width: 380,  height: 720  },
  { name: 'tablet',  width: 1024, height: 768  },
  { name: 'desktop', width: 1920, height: 1080 },
] as const;

export const LANGS = ['en', 'zh'] as const;
