# Wiltek Portal — Deployment Workflow

Long-term branch-based deployment for the Wiltek Portal (V2 is the live portal;
`Wiltek_MASTER.html` is the V1 fallback). Static site lives at repo root; APIs
in `api/*.js` (Vercel functions, 12-function cap).

## Branches

| Branch | Vercel deployment | Audience | When to deploy |
|--------|-------------------|----------|----------------|
| `main` | `wiltek-dashboard.vercel.app` (PROD) | 9 users (Owner + 8 staff) | Merge from `develop` after Jym signs off |
| `develop` | `wiltek-dashboard-git-develop-<org>.vercel.app` (STAGING) | Jym only | Merge feature branches here first; soak 2–7 days before promoting to `main` |
| `feature/*` | `wiltek-dashboard-git-feature-<branch>-<org>.vercel.app` (PREVIEW) | Claude Code + Jym spot-check | Auto-created per PR |

> `<org>` = the Vercel org/team slug (see `docs/VERCEL_SETUP.md` Step 3 for the
> exact staging URL printed by Vercel).

## Workflow

### For every change (Claude Code)

1. Branch off `develop`, name `feature/<short-desc>` (e.g. `feature/finance-page`).
2. Push commits → open a PR **targeting `develop`** (not `main`).
3. Vercel auto-deploys a preview at the `feature/*` URL.
4. Paste the preview URL in the PR description for Jym to test.
5. Jym tests on preview → comments "OK to merge to develop" or "issues found".
6. Merge the PR to `develop` (Jym, or Claude Code once approved).
7. Staging URL auto-updates.

### Promoting to production

1. Jym soaks staging for 2–7 days; finds no issues.
2. Jym opens a "promote" PR: `develop` → `main`.
3. Merge → auto-deploy to `wiltek-dashboard.vercel.app`.
4. Tag the commit (e.g. `git tag v2.1.0 && git push --tags`).
5. Update `CHANGELOG.md` (if present).

## Rollback (if prod breaks)

1. Vercel dashboard → Deployments → find last good `main` deployment → **Promote to Production**, OR
2. `git revert <bad-commit>` on `main` → auto-deploy.

## What NEVER goes directly to `main`

- Untested features.
- Supabase schema migrations without staging validation.
- Apps Script changes (external — stage via a separate Apps Script project where possible).

## Local checks before opening a PR

```bash
npm run test:i18n   # 0 hardcoded 中文 in render; dict purity (en 无中文 / zh 无整段英文)
npm run test:rbac   # 9-user × 9-page access matrix + store-scope
npm run test:e2e    # Playwright (if applicable)
```
