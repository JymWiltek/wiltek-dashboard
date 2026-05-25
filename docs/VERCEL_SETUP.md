# Vercel Branch Setup (Jym — do once)

One-time setup so the branch workflow in `docs/DEPLOYMENT.md` works:
`main` = production, `develop` = staging, `feature/*` = preview.

## Step 1 — Create the `develop` branch

```bash
git checkout main
git pull
git checkout -b develop
git push -u origin develop
```

## Step 2 — Vercel project settings

1. https://vercel.com/dashboard → **wiltek-dashboard**
2. Settings → Git → **Production Branch**: confirm it is `main` (do NOT change).
3. Settings → Git → Deploy Hooks → leave as-is.
4. Settings → Domains → confirm `wiltek-dashboard.vercel.app` is bound to `main`.

> Vercel auto-creates preview deployments for every branch/PR by default — no
> extra config needed for `develop` (staging) or `feature/*` (preview) URLs.

## Step 3 — Verify the staging URL

1. Push an empty commit to `develop` (or update `CHANGELOG.md`):
   ```bash
   git checkout develop && git commit --allow-empty -m "chore: trigger staging deploy" && git push
   ```
2. Wait ~2 min for Vercel to build.
3. Open `https://wiltek-dashboard-git-develop-<your-org>.vercel.app`
   (the exact URL is shown in the Vercel deployment list — copy it into
   `docs/DEPLOYMENT.md`, replacing `<org>`).
4. You should see V2, identical to `main` (since `develop` == `main` right now).

## Step 4 — From now on

- Claude Code opens PRs with base `develop` (never `main` directly).
- Jym tests the preview/staging URL, then opens a `develop` → `main` PR to ship.
- Emergency hotfix: PR straight to `main`, then cherry-pick onto `develop`:
  ```bash
  git checkout develop && git cherry-pick <hotfix-commit> && git push
  ```

## Notes

- This PR (`v2-launch`) targets `main` because `develop` does not exist yet.
  After you complete Step 1, the next PR will use the `feature/*` → `develop` flow.
- The 12-function Vercel cap still applies — don't add new `api/*.js` endpoints
  without folding into the existing dispatchers (`/api/kpi`, `/api/sync`, etc.).
