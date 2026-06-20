-- ═══════════════════════════════════════════════════════════════════════
-- Wiltek Portal V2 · RLS lock-down migration  (DRAFT 2026-06-18)
-- ═══════════════════════════════════════════════════════════════════════
-- Closes the anon read/write exposure found in the 2026-06-18 RLS audit
-- (Steps 1–2). Covers EVERYTHING, not just the 9 RLS-off tables: also the
-- customers `using(true)` hole, the 8 SECURITY DEFINER views, the 5 anon-
-- readable materialized views, and the anon-executable SecDef function.
--
-- ⚠️  DRAFT — DO NOT RUN UNREVIEWED. Review with Jym first.
--
-- SAFETY MODEL (why the live Portal is unaffected):
--   • The Portal NEVER uses the anon key. Browser → /api/* (Vercel) →
--     Supabase with the SERVICE_ROLE key. service_role BYPASSES RLS and is
--     unaffected by GRANT/REVOKE to anon. Verified in Step 1 (every api/*.js
--     uses WILTEK_SUPABASE_SERVICE_ROLE_KEY; no createClient/anon in the HTML).
--   • The RPCs the Portal calls (overview_kpi, customers_payload, …) are
--     SECURITY INVOKER → run as the caller. service_role bypasses RLS so they
--     keep working; anon calling them post-lockdown gets RLS-filtered (empty).
--   • This migration is run by the postgres/owner role (Supabase SQL editor /
--     apply_migration), NOT anon — so revoking anon never locks out the runner.
--
-- ROLE MODEL (existing): policies gate on app_current_role()/app_current_store(),
--   which read users via current_setting('app.current_user', true). A raw anon
--   connection sets no GUC → those helpers return NULL → every role check is
--   false → anon denied. (This is why users is already safe today.)
--
-- ORDER: enable RLS → add policies → fix customers/items → revoke view/MV/
--   function grants → revoke broad anon table grants → verify. Nothing locks
--   out the runner at any step.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- SECTION 1 — Enable RLS + policies on the 9 currently-OFF tables.
-- Closes: anon (and any non-service_role) full read+write on financials,
-- PII purchase lines, targets, purchasing, ops/admin tables.
-- Pattern: SELECT policy per sensitivity; modify (INSERT/UPDATE/DELETE)
-- restricted to owner. service_role bypasses all of this.
-- ─────────────────────────────────────────────────────────────────────

-- 1a. FINANCIAL (company-level, no store column) — owner (+ finance) read only.
--     NOTE: the 9-user model has NO dedicated 'finance' role today, so this is
--     owner-only in practice. To grant finance staff later, change the read
--     condition to:  app_current_role() IN ('owner','finance')
ALTER TABLE public.financial_balance_sheet ENABLE ROW LEVEL SECURITY;
CREATE POLICY fbs_select_finance ON public.financial_balance_sheet
  FOR SELECT USING (app_current_role() = 'owner');
CREATE POLICY fbs_modify_owner ON public.financial_balance_sheet
  FOR ALL USING (app_current_role() = 'owner') WITH CHECK (app_current_role() = 'owner');

ALTER TABLE public.financial_monthly ENABLE ROW LEVEL SECURITY;
CREATE POLICY fm_select_finance ON public.financial_monthly
  FOR SELECT USING (app_current_role() = 'owner');
CREATE POLICY fm_modify_owner ON public.financial_monthly
  FOR ALL USING (app_current_role() = 'owner') WITH CHECK (app_current_role() = 'owner');

ALTER TABLE public.financial_brand_margin ENABLE ROW LEVEL SECURITY;
CREATE POLICY fbm_select_finance ON public.financial_brand_margin
  FOR SELECT USING (app_current_role() = 'owner');
CREATE POLICY fbm_modify_owner ON public.financial_brand_margin
  FOR ALL USING (app_current_role() = 'owner') WITH CHECK (app_current_role() = 'owner');

-- 1b. PII — customer_buy_lines (has `branch`). owner sees all; a store manager
--     sees own branch. Writes owner-only.
ALTER TABLE public.customer_buy_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY cbl_select_owner_or_store ON public.customer_buy_lines
  FOR SELECT USING (app_current_role() = 'owner' OR branch = app_current_store());
CREATE POLICY cbl_modify_owner ON public.customer_buy_lines
  FOR ALL USING (app_current_role() = 'owner') WITH CHECK (app_current_role() = 'owner');

-- 1c. monthly_targets (has `store`). owner-or-own-store read; writes owner-only.
ALTER TABLE public.monthly_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY mt_select_owner_or_store ON public.monthly_targets
  FOR SELECT USING (app_current_role() = 'owner' OR store = app_current_store());
CREATE POLICY mt_modify_owner ON public.monthly_targets
  FOR ALL USING (app_current_role() = 'owner') WITH CHECK (app_current_role() = 'owner');

-- 1d. po_grn (purchasing, has `branch`). owner-or-own-branch read; writes owner.
ALTER TABLE public.po_grn ENABLE ROW LEVEL SECURITY;
CREATE POLICY pg_select_owner_or_store ON public.po_grn
  FOR SELECT USING (app_current_role() = 'owner' OR branch = app_current_store());
CREATE POLICY pg_modify_owner ON public.po_grn
  FOR ALL USING (app_current_role() = 'owner') WITH CHECK (app_current_role() = 'owner');

-- 1e. actions_assigned (派派盒). No store column; scoped by assigner/assignee
--     role-ids. The manager inbox is served by /api/* (service_role) filtered
--     by assignee, so RLS here is owner-only (defense in depth). Adjust later
--     if a direct-key manager path is ever added.
ALTER TABLE public.actions_assigned ENABLE ROW LEVEL SECURITY;
CREATE POLICY aa_select_owner ON public.actions_assigned
  FOR SELECT USING (app_current_role() = 'owner');
CREATE POLICY aa_modify_owner ON public.actions_assigned
  FOR ALL USING (app_current_role() = 'owner') WITH CHECK (app_current_role() = 'owner');

-- 1f. backups_manifest + sync_log (ops/admin metadata). owner-only.
ALTER TABLE public.backups_manifest ENABLE ROW LEVEL SECURITY;
CREATE POLICY bm_select_owner ON public.backups_manifest
  FOR SELECT USING (app_current_role() = 'owner');
CREATE POLICY bm_modify_owner ON public.backups_manifest
  FOR ALL USING (app_current_role() = 'owner') WITH CHECK (app_current_role() = 'owner');

ALTER TABLE public.sync_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY sl_select_owner ON public.sync_log
  FOR SELECT USING (app_current_role() = 'owner');
CREATE POLICY sl_modify_owner ON public.sync_log
  FOR ALL USING (app_current_role() = 'owner') WITH CHECK (app_current_role() = 'owner');

-- ─────────────────────────────────────────────────────────────────────
-- SECTION 2 — Fix customers `customers_select_all USING (true)`.
-- Closes: anon (and everyone) could read ALL customer PII even though RLS was
-- "on", because the SELECT policy was unconditionally true. Replace with the
-- same owner-or-own-store gate used on sales/inventory. customers has no plain
-- `store` column — its store field is `primary_store`.
-- ─────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS customers_select_all ON public.customers;
CREATE POLICY customers_select_owner_or_store ON public.customers
  FOR SELECT USING (app_current_role() = 'owner' OR primary_store = app_current_store());
-- (customers_insert_owner / customers_update_owner / customers_delete_owner
--  already exist and are owner-gated — left unchanged.)

-- ─────────────────────────────────────────────────────────────────────
-- SECTION 3 — Fix items `items_select_all USING (true)` (REFERENCE data).
-- Decision: readable to AUTHENTICATED only, never anon. (anon also loses the
-- table grant in Section 7.) Writes stay owner-only (unchanged).
-- ─────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS items_select_all ON public.items;
CREATE POLICY items_select_authenticated ON public.items
  FOR SELECT TO authenticated USING (true);
-- (items_insert_owner / items_update_owner / items_delete_owner unchanged.)

-- ─────────────────────────────────────────────────────────────────────
-- SECTION 4 — SECURITY DEFINER views: revoke anon SELECT.
-- Closes: these 8 views run as their creator and BYPASS table RLS, so anon
-- could read member PII (v_member_purchases*) and sales/financial figures
-- (v_sales_*, v_total_amt_by_month, v_sku_*) regardless of Section 1/2. All 8
-- are anon-SELECTable today (Step 2 verified). Revoking the grant is the fix;
-- the cleaner long-term option is to recreate them as SECURITY INVOKER (then
-- RLS applies to the caller) — deferred to avoid recreating 8 view bodies here.
REVOKE SELECT ON public.v_sku_qty_by_item_branch_90d FROM anon;
REVOKE SELECT ON public.v_item_last_sale            FROM anon;
REVOKE SELECT ON public.v_sales_kpi_monthly         FROM anon;
REVOKE SELECT ON public.v_sales_by_branch_month     FROM anon;
REVOKE SELECT ON public.v_total_amt_by_month        FROM anon;
REVOKE SELECT ON public.v_sku_by_month_branch       FROM anon;
REVOKE SELECT ON public.v_member_purchases          FROM anon;
REVOKE SELECT ON public.v_member_purchases_by_cat   FROM anon;
-- OPTIONAL (defense in depth — no authenticated consumer exists in this app;
-- uncomment if you also want to deny a hypothetical authenticated key):
-- REVOKE SELECT ON public.v_sku_qty_by_item_branch_90d, public.v_item_last_sale,
--   public.v_sales_kpi_monthly, public.v_sales_by_branch_month,
--   public.v_total_amt_by_month, public.v_sku_by_month_branch,
--   public.v_member_purchases, public.v_member_purchases_by_cat FROM authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- SECTION 5 — Materialized views: revoke anon SELECT.
-- Closes: MVs cannot carry RLS and are exposed over the Data API; all 5 are
-- anon-SELECTable today, leaking sales/inventory/customer/floatation/product
-- KPI aggregates. (Portal reads source RPCs via service_role, not these MVs.)
REVOKE SELECT ON public.mv_sales_kpi_monthly      FROM anon;
REVOKE SELECT ON public.mv_inventory_kpi_monthly  FROM anon;
REVOKE SELECT ON public.mv_customers_kpi_monthly  FROM anon;
REVOKE SELECT ON public.mv_floatation_kpi_monthly FROM anon;
REVOKE SELECT ON public.mv_products_kpi_monthly   FROM anon;
-- OPTIONAL (also deny authenticated):
-- REVOKE SELECT ON public.mv_sales_kpi_monthly, public.mv_inventory_kpi_monthly,
--   public.mv_customers_kpi_monthly, public.mv_floatation_kpi_monthly,
--   public.mv_products_kpi_monthly FROM authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- SECTION 6 — anon-executable SECURITY DEFINER functions.
-- Closes: actions_sweep_overdue() is the ONLY SecDef function anon (and
-- authenticated) can call via /rest/v1/rpc (full-DB scan of prosecdef=true
-- confirmed it is the only one). It has a write side-effect (sweeps overdue
-- actions). All the Portal's data RPCs are SECURITY INVOKER, so they are NOT
-- listed here. Revoke EXECUTE from anon + authenticated; service_role/postgres
-- keep it (sync/cron path).
-- NOTE: EXECUTE was granted to PUBLIC (Postgres default), so revoking from
-- anon/authenticated alone is NOT enough — anon stays able to call it via the
-- PUBLIC grant. Revoke from PUBLIC too (branch-tested 2026-06-19: with PUBLIC
-- the anon-executable SecDef count drops to 0). service_role/postgres keep it.
REVOKE EXECUTE ON FUNCTION public.actions_sweep_overdue() FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- SECTION 7 — Revoke the broad anon table grants (read + write) everywhere.
-- Closes: today anon holds SELECT/INSERT/UPDATE/DELETE on every public table.
-- With RLS now enabled, policies already deny anon — this removes the grants
-- too (belt + suspenders; also stops anon writes on any table). Applies to
-- base tables AND regular views in the schema. service_role/postgres untouched.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon;
-- Future objects: don't hand anon anything by default going forward.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;
-- NOTE: `ALL TABLES IN SCHEMA` does NOT include materialized views in Postgres,
-- which is why the 5 MVs are revoked explicitly in Section 5.

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATION — run AFTER the migration (read-only). anon should be able to
-- do NOTHING; service_role (Portal) is unaffected (bypasses RLS).
-- Expected: every anon_* column below = false; rls_enabled = true on all tables.
-- ═══════════════════════════════════════════════════════════════════════

-- 7a. Per-table: RLS on? anon still has any privilege?
SELECT c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
       has_table_privilege('anon', c.oid, 'SELECT') AS anon_select,
       has_table_privilege('anon', c.oid, 'INSERT') AS anon_insert,
       has_table_privilege('anon', c.oid, 'UPDATE') AS anon_update,
       has_table_privilege('anon', c.oid, 'DELETE') AS anon_delete
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relname;

-- 7b. Views + materialized views: anon SELECT (expect all false).
SELECT c.relname AS object,
       CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' END AS kind,
       has_table_privilege('anon', c.oid, 'SELECT') AS anon_select
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('v','m')
ORDER BY kind, object;

-- 7c. SECURITY DEFINER functions still anon-executable (expect zero rows).
SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef = true
  AND has_function_privilege('anon', p.oid, 'EXECUTE') = true;

-- 7d. Sanity: confirm the two `using(true)` holes are gone (expect zero rows).
SELECT tablename, policyname, qual
FROM pg_policies
WHERE schemaname = 'public' AND qual = 'true'
  AND tablename IN ('customers','items');
