-- ═══════════════════════════════════════════════════════════════════════
-- Wiltek Phase 4 — Sales Module V3 (Agentic OS · 2-Tier)
-- Migration: actions_assigned table + 5 sales RPCs
-- ═══════════════════════════════════════════════════════════════════════
-- TO APPLY: Claude-chat runs this via Supabase MCP (single transaction).
-- IDEMPOTENT: every CREATE uses IF NOT EXISTS / OR REPLACE.
--
-- Frontend & backend handlers in /api/sync + /api/kpi degrade gracefully
-- if this hasn't been applied yet (banner alerts per hard rule #13/#14).
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A.1 actions_assigned table ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.actions_assigned (
  id BIGSERIAL PRIMARY KEY,

  module TEXT NOT NULL,
  assigner TEXT NOT NULL,
  assignee TEXT NOT NULL,

  title TEXT NOT NULL,
  description TEXT,
  amount NUMERIC(14,2),
  amount_unit TEXT,
  ddl DATE,
  severity TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'pending',

  proposed_ddl DATE,
  proposed_amount NUMERIC(14,2),
  proposed_note TEXT,

  source_url TEXT,
  source_data JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  done_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,

  done_note TEXT,

  CONSTRAINT actions_severity_chk
    CHECK (severity IN ('red','amber','green')),
  CONSTRAINT actions_status_chk
    CHECK (status IN ('pending','accepted','done','overdue','rejected','renegotiating')),
  CONSTRAINT actions_module_chk
    CHECK (module IN ('sales','inventory','customer','products','marketing','purchasing','hr','finance'))
);

CREATE INDEX IF NOT EXISTS idx_actions_assignee_status ON public.actions_assigned(assignee, status);
CREATE INDEX IF NOT EXISTS idx_actions_assigner_status ON public.actions_assigned(assigner, status);
CREATE INDEX IF NOT EXISTS idx_actions_module_ddl     ON public.actions_assigned(module, ddl);
CREATE INDEX IF NOT EXISTS idx_actions_created        ON public.actions_assigned(created_at DESC);

COMMENT ON TABLE public.actions_assigned IS
  'Wiltek Agentic OS — cross-tier Action assignment. Tier 1 派 → Tier 2 接 → 状态回流.';

-- ── A.1 daily overdue auto-detection ───────────────────────────────────
-- Marks any pending/accepted Action whose ddl has passed as 'overdue'.
-- Call once per day from a cron OR a scheduled Vercel cron that hits
-- /api/sync mode=actions_sweep_overdue.
CREATE OR REPLACE FUNCTION public.actions_sweep_overdue()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  n INT;
BEGIN
  UPDATE public.actions_assigned
     SET status = 'overdue'
   WHERE status IN ('pending','accepted')
     AND ddl IS NOT NULL
     AND ddl < CURRENT_DATE;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- A.2 · Sales RPCs (5)
-- All read from mv_sales_kpi_monthly + monthly_targets + sales + items.
-- Owner = sees all; manager scoping enforced by handler-level x-wp-user
-- check (RPCs don't know who's calling).
-- ═══════════════════════════════════════════════════════════════════════

-- ── RPC 1: sales_owner_overview(ym) ───────────────────────────────────
-- Returns company + per-store + anomalies in one JSON blob.
-- Used by Tier 1 hero strip + store matrix + action-plan anomalies.
CREATE OR REPLACE FUNCTION public.sales_owner_overview(p_ym TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_curr        RECORD;
  v_prev        RECORD;
  v_lyr         RECORD;
  v_six_avg     NUMERIC;
  v_target_tot  NUMERIC;
  v_company     JSONB;
  v_stores      JSONB;
  v_anomalies   JSONB;
BEGIN
  -- Current month KPI from mview
  SELECT * INTO v_curr
    FROM public.mv_sales_kpi_monthly
   WHERE ym = p_ym;

  -- Prev month for vs-last-month
  SELECT * INTO v_prev
    FROM public.mv_sales_kpi_monthly
   WHERE ym = TO_CHAR((p_ym || '-01')::date - INTERVAL '1 month', 'YYYY-MM');

  -- Last year same month
  SELECT * INTO v_lyr
    FROM public.mv_sales_kpi_monthly
   WHERE ym = TO_CHAR((p_ym || '-01')::date - INTERVAL '1 year', 'YYYY-MM');

  -- 6-month avg (excluding current)
  SELECT AVG(sales) INTO v_six_avg
    FROM public.mv_sales_kpi_monthly
   WHERE ym <  p_ym
     AND ym >= TO_CHAR((p_ym || '-01')::date - INTERVAL '6 month', 'YYYY-MM');

  -- Company target = sum of monthly_targets sales
  SELECT COALESCE(SUM(target_value), 0) INTO v_target_tot
    FROM public.monthly_targets
   WHERE ym = p_ym
     AND target_type = 'sales';

  -- Company block
  v_company := jsonb_build_object(
    'sales',                COALESCE(v_curr.sales, 0),
    'target',               v_target_tot,
    'pct',                  CASE WHEN v_target_tot > 0
                                 THEN ROUND(COALESCE(v_curr.sales, 0) / v_target_tot * 100, 1)
                                 ELSE NULL END,
    'shortfall',            v_target_tot - COALESCE(v_curr.sales, 0),
    'invoices',             COALESCE(v_curr.invoices, 0),
    'units',                COALESCE(v_curr.units, 0),
    'aov',                  CASE WHEN COALESCE(v_curr.invoices, 0) > 0
                                 THEN ROUND(v_curr.sales / v_curr.invoices, 2)
                                 ELSE NULL END,
    'vs_last_month_pct',    CASE WHEN COALESCE(v_prev.sales, 0) > 0
                                 THEN ROUND((v_curr.sales - v_prev.sales) / v_prev.sales * 100, 1)
                                 ELSE NULL END,
    'vs_last_year_pct',     CASE WHEN COALESCE(v_lyr.sales, 0) > 0
                                 THEN ROUND((v_curr.sales - v_lyr.sales) / v_lyr.sales * 100, 1)
                                 ELSE NULL END,
    'vs_6mo_avg_pct',       CASE WHEN COALESCE(v_six_avg, 0) > 0
                                 THEN ROUND((v_curr.sales - v_six_avg) / v_six_avg * 100, 1)
                                 ELSE NULL END
  );

  -- Per-store rows
  WITH s AS (
    SELECT store,
           SUM(amount)::NUMERIC      AS actual,
           COUNT(DISTINCT invoice_no) AS invoices,
           SUM(qty)::INT             AS units
      FROM public.sales
     WHERE TO_CHAR(sale_date, 'YYYY-MM') = p_ym
     GROUP BY store
  ),
  t AS (
    SELECT store, target_value AS target
      FROM public.monthly_targets
     WHERE ym = p_ym AND target_type = 'sales'
  ),
  merged AS (
    SELECT COALESCE(s.store, t.store)            AS store,
           COALESCE(s.actual, 0)                  AS actual,
           COALESCE(t.target, 0)                  AS target,
           s.invoices,
           s.units
      FROM s FULL OUTER JOIN t ON s.store = t.store
  ),
  ranked AS (
    SELECT store,
           actual,
           target,
           invoices,
           units,
           CASE WHEN target > 0
                THEN ROUND(actual / target * 100, 1) ELSE NULL END     AS pct,
           target - actual                                              AS shortfall,
           CASE WHEN target = 0                THEN 'no_target'
                WHEN actual / NULLIF(target,0) >= 1.0 THEN 'exceeded'
                WHEN actual / NULLIF(target,0) >= 0.85 THEN 'approaching'
                WHEN actual / NULLIF(target,0) >= 0.5  THEN 'behind'
                ELSE 'critical' END                                     AS status,
           ROW_NUMBER() OVER (ORDER BY (actual / NULLIF(target,0)) DESC NULLS LAST) AS rnk
      FROM merged
     WHERE actual > 0 OR target > 0
  )
  SELECT jsonb_agg(jsonb_build_object(
           'store',     store,
           'actual',    actual,
           'target',    target,
           'pct',       pct,
           'shortfall', shortfall,
           'invoices',  invoices,
           'units',     units,
           'aov',       CASE WHEN COALESCE(invoices,0) > 0 THEN ROUND(actual/invoices, 2) ELSE NULL END,
           'status',    status,
           'rank',      rnk
         ) ORDER BY pct NULLS LAST) INTO v_stores
    FROM ranked;

  -- Anomalies = severity-tagged action seeds. Frontend uses these for
  -- the Action Plan + assign-modal prefill. (Code-side归因 also runs for
  -- richer text; this server-side block guarantees the seed set.)
  WITH r AS (
    SELECT *
      FROM jsonb_to_recordset(v_stores)
        AS x(store TEXT, actual NUMERIC, target NUMERIC, pct NUMERIC,
             shortfall NUMERIC, status TEXT, invoices INT, units INT, aov NUMERIC, rank INT)
  )
  SELECT jsonb_agg(jsonb_build_object(
           'id',                  store || '-' || status,
           'severity',            CASE status
                                    WHEN 'critical' THEN 'red'
                                    WHEN 'behind'   THEN 'red'
                                    WHEN 'exceeded' THEN 'green'
                                    ELSE 'amber' END,
           'store',               store,
           'title',               store || CASE status
                                            WHEN 'critical' THEN ' 严重落后 - 仅完成 ' || pct || '%'
                                            WHEN 'behind'   THEN ' 落后 - 完成 ' || pct || '%'
                                            WHEN 'exceeded' THEN ' 超目标 ' || (pct - 100)::INT || '%'
                                            ELSE ' 接近目标 - 完成 ' || pct || '%' END,
           'detail',              '实际 RM ' || TRIM(TO_CHAR(actual, 'FM999,999,999'))
                                    || ' · 目标 RM ' || TRIM(TO_CHAR(target, 'FM999,999,999'))
                                    || ' · ' || CASE WHEN shortfall > 0
                                                     THEN '缺口 RM ' || TRIM(TO_CHAR(shortfall, 'FM999,999,999'))
                                                     ELSE '超 RM ' || TRIM(TO_CHAR(-shortfall, 'FM999,999,999')) END,
           'recommended_action',  CASE status
                                    WHEN 'critical' THEN '现场调研 ' || store
                                    WHEN 'behind'   THEN store || ' 本月追 RM ' || shortfall::INT
                                    WHEN 'exceeded' THEN '复盘 ' || store || ' 做对了什么, 推广到他店'
                                    ELSE store || ' 本月追 RM ' || GREATEST(shortfall, 0)::INT END,
           'recommended_assignee',CASE
                                    WHEN status IN ('critical','exceeded') THEN 'owner'
                                    ELSE LOWER(store) || '_manager' END,
           'recommended_amount',  GREATEST(shortfall, 0),
           'shortfall',           shortfall
         )) INTO v_anomalies
    FROM r
   WHERE status IN ('critical','behind','exceeded');

  RETURN jsonb_build_object(
    'month',      p_ym,
    'company',    v_company,
    'stores',     COALESCE(v_stores, '[]'::jsonb),
    'anomalies',  COALESCE(v_anomalies, '[]'::jsonb)
  );
END $$;

-- ── RPC 2: sales_store_view(store, ym) ────────────────────────────────
-- Returns single-store data + peer ranking (pct + rank only, no $).
CREATE OR REPLACE FUNCTION public.sales_store_view(p_store TEXT, p_ym TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_actual     NUMERIC;
  v_target     NUMERIC;
  v_invoices   INT;
  v_units      INT;
  v_prev       NUMERIC;
  v_lyr        NUMERIC;
  v_six_avg    NUMERIC;
  v_peer       JSONB;
  v_aov_all    NUMERIC;
  v_anom       JSONB;
BEGIN
  SELECT SUM(amount), COUNT(DISTINCT invoice_no), SUM(qty)
    INTO v_actual, v_invoices, v_units
    FROM public.sales
   WHERE TO_CHAR(sale_date, 'YYYY-MM') = p_ym
     AND store = p_store;

  SELECT target_value INTO v_target
    FROM public.monthly_targets
   WHERE ym = p_ym AND target_type = 'sales' AND store = p_store;

  -- Prev / last-year / 6mo avg (per-store)
  SELECT SUM(amount) INTO v_prev
    FROM public.sales
   WHERE TO_CHAR(sale_date, 'YYYY-MM') = TO_CHAR((p_ym || '-01')::date - INTERVAL '1 month', 'YYYY-MM')
     AND store = p_store;

  SELECT SUM(amount) INTO v_lyr
    FROM public.sales
   WHERE TO_CHAR(sale_date, 'YYYY-MM') = TO_CHAR((p_ym || '-01')::date - INTERVAL '1 year', 'YYYY-MM')
     AND store = p_store;

  WITH past6 AS (
    SELECT TO_CHAR(sale_date, 'YYYY-MM') AS ym, SUM(amount) AS s
      FROM public.sales
     WHERE store = p_store
       AND sale_date >= (p_ym || '-01')::date - INTERVAL '6 month'
       AND sale_date <  (p_ym || '-01')::date
     GROUP BY 1
  )
  SELECT AVG(s) INTO v_six_avg FROM past6;

  -- Peer ranking (pct + rank only — privacy filter)
  WITH ranked AS (
    SELECT m.store,
           CASE WHEN t.target_value > 0
                THEN ROUND(COALESCE(s.actual, 0) / t.target_value * 100, 1)
                ELSE NULL END AS pct,
           CASE WHEN t.target_value = 0                  THEN 'no_target'
                WHEN COALESCE(s.actual,0) >= t.target_value      THEN 'exceeded'
                WHEN COALESCE(s.actual,0) >= t.target_value*0.85 THEN 'approaching'
                WHEN COALESCE(s.actual,0) >= t.target_value*0.5  THEN 'behind'
                ELSE 'critical' END AS status,
           ROW_NUMBER() OVER (ORDER BY COALESCE(s.actual,0) / NULLIF(t.target_value,0) DESC NULLS LAST) AS rnk
      FROM public.monthly_targets t
      LEFT JOIN (
        SELECT store, SUM(amount) AS actual
          FROM public.sales
         WHERE TO_CHAR(sale_date, 'YYYY-MM') = p_ym
         GROUP BY store
      ) s ON s.store = t.store
     CROSS JOIN (VALUES (1)) m_ -- silence
     LEFT JOIN public.monthly_targets m ON m.store = t.store
     WHERE t.ym = p_ym AND t.target_type = 'sales'
     GROUP BY m.store, t.target_value, s.actual
  )
  SELECT jsonb_agg(jsonb_build_object(
           'rank',   rnk,
           'store',  store,
           'pct',    pct,
           'status', status
         ) ORDER BY rnk)
    INTO v_peer
    FROM ranked;

  -- Company AOV (for anomaly归因)
  SELECT CASE WHEN SUM(DISTINCT 1) > 0
              AND SUM(qty) > 0
              THEN ROUND(SUM(amount)/COUNT(DISTINCT invoice_no), 2)
              ELSE NULL END
    INTO v_aov_all
    FROM public.sales
   WHERE TO_CHAR(sale_date, 'YYYY-MM') = p_ym;

  -- Store anomalies (simple heuristics; richer归因 done frontend-side)
  v_anom := '[]'::jsonb;
  IF v_invoices IS NOT NULL AND v_target IS NOT NULL AND v_target > 0 THEN
    v_anom := v_anom ||
      CASE WHEN v_actual / v_target < 0.85
           THEN jsonb_build_array(jsonb_build_object(
             'severity','red',
             'title','本月进度落后 ' || ROUND(v_actual/v_target*100,1) || '%',
             'detail','实际 RM ' || TRIM(TO_CHAR(v_actual, 'FM999,999,999'))
                        || ' · 目标 RM ' || TRIM(TO_CHAR(v_target, 'FM999,999,999'))
                        || ' · 缺口 RM ' || TRIM(TO_CHAR(v_target - v_actual, 'FM999,999,999'))))
           ELSE '[]'::jsonb END;
  END IF;

  RETURN jsonb_build_object(
    'month',           p_ym,
    'store',           p_store,
    'actual',          COALESCE(v_actual, 0),
    'target',          COALESCE(v_target, 0),
    'invoices',        COALESCE(v_invoices, 0),
    'units',           COALESCE(v_units, 0),
    'aov',             CASE WHEN COALESCE(v_invoices,0) > 0 THEN ROUND(v_actual/v_invoices, 2) ELSE NULL END,
    'pct',             CASE WHEN COALESCE(v_target, 0) > 0
                            THEN ROUND(v_actual/v_target * 100, 1) ELSE NULL END,
    'shortfall',       COALESCE(v_target, 0) - COALESCE(v_actual, 0),
    'vs_last_month',   v_prev,
    'vs_last_year',    v_lyr,
    'vs_6mo_avg',      v_six_avg,
    'company_aov',     v_aov_all,
    'peer_ranking',    COALESCE(v_peer, '[]'::jsonb),
    'anomalies',       v_anom
  );
END $$;

-- ── RPC 3: sales_drill_category(ym, store) ────────────────────────────
-- Returns { status, message?, rows? }. items.main_group may be absent /
-- mostly NULL — surfaces a data_gap status instead of silent empty.
CREATE OR REPLACE FUNCTION public.sales_drill_category(
  p_ym    TEXT,
  p_store TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_nonnull INT;
  v_rows    JSONB;
BEGIN
  SELECT COUNT(*) INTO v_nonnull
    FROM public.items
   WHERE main_group IS NOT NULL AND main_group <> '';
  IF v_nonnull = 0 THEN
    RETURN jsonb_build_object(
      'status',  'data_gap',
      'message', '品类拆分需 items.main_group, 暂未接入 / 全部为空');
  END IF;

  WITH joined AS (
    SELECT COALESCE(NULLIF(i.main_group, ''), '(未分类)') AS category,
           s.amount, s.qty, s.invoice_no, s.store
      FROM public.sales s
      JOIN public.items i ON i.item_code = s.item_code
     WHERE TO_CHAR(s.sale_date, 'YYYY-MM') = p_ym
       AND (p_store IS NULL OR s.store = p_store)
  ),
  agg AS (
    SELECT category,
           SUM(amount)::NUMERIC(14,2)             AS sales,
           COUNT(DISTINCT invoice_no)             AS invoices,
           SUM(qty)::INT                          AS units
      FROM joined
     GROUP BY category
     ORDER BY SUM(amount) DESC
     LIMIT 20
  )
  SELECT jsonb_agg(jsonb_build_object(
           'category', category,
           'sales',    sales,
           'invoices', invoices,
           'units',    units,
           'aov',      CASE WHEN invoices > 0 THEN ROUND(sales/invoices, 2) ELSE NULL END
         ) ORDER BY sales DESC) INTO v_rows
    FROM agg;

  RETURN jsonb_build_object(
    'status', 'ok',
    'rows',   COALESCE(v_rows, '[]'::jsonb));
END $$;

-- ── RPC 4: sales_drill_customer_type(ym, store) ───────────────────────
CREATE OR REPLACE FUNCTION public.sales_drill_customer_type(
  p_ym    TEXT,
  p_store TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_has_cbl INT;
  v_rows    JSONB;
BEGIN
  SELECT COUNT(*) INTO v_has_cbl
    FROM public.customer_buy_lines
   WHERE date >= (p_ym || '-01')::date
     AND date <  (p_ym || '-01')::date + INTERVAL '1 month';
  IF v_has_cbl = 0 THEN
    RETURN jsonb_build_object(
      'status',  'data_gap',
      'message', 'customer_buy_lines 本月无数据, 客型拆分无法计算');
  END IF;

  WITH joined AS (
    SELECT COALESCE(NULLIF(c.cust_type, ''), '(unknown)') AS cust_type,
           cbl.amount, cbl.store
      FROM public.customer_buy_lines cbl
      LEFT JOIN public.customers c ON c.cust_id = cbl.cust_id
     WHERE cbl.date >= (p_ym || '-01')::date
       AND cbl.date <  (p_ym || '-01')::date + INTERVAL '1 month'
       AND (p_store IS NULL OR cbl.store = p_store)
  ),
  agg AS (
    SELECT cust_type,
           SUM(amount)::NUMERIC(14,2)  AS sales,
           COUNT(*)                    AS rows
      FROM joined
     GROUP BY cust_type
  )
  SELECT jsonb_agg(jsonb_build_object(
           'cust_type', cust_type,
           'sales',     sales,
           'rows',      rows
         ) ORDER BY sales DESC) INTO v_rows
    FROM agg;

  RETURN jsonb_build_object(
    'status', 'ok',
    'rows',   COALESCE(v_rows, '[]'::jsonb));
END $$;

-- ── RPC 5: sales_drill_supplier(ym, store) — OEM vs Local Agency ──────
CREATE OR REPLACE FUNCTION public.sales_drill_supplier(
  p_ym    TEXT,
  p_store TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_has_country INT;
  v_oem_sales NUMERIC; v_loc_sales NUMERIC;
  v_oem_inv INT; v_loc_inv INT;
BEGIN
  SELECT COUNT(*) INTO v_has_country
    FROM public.items
   WHERE country IS NOT NULL AND country <> '';
  IF v_has_country = 0 THEN
    RETURN jsonb_build_object(
      'status',  'data_gap',
      'message', 'items.country 字段全空, OEM/Agency 无法拆分');
  END IF;

  WITH joined AS (
    SELECT CASE WHEN UPPER(COALESCE(i.country, '')) = 'CHINA' THEN 'OEM'
                WHEN UPPER(COALESCE(i.country, '')) IN ('MALAYSIA','LOCAL') THEN 'Local Agency'
                ELSE 'Other' END AS bucket,
           s.amount, s.invoice_no
      FROM public.sales s
      JOIN public.items i ON i.item_code = s.item_code
     WHERE TO_CHAR(s.sale_date, 'YYYY-MM') = p_ym
       AND (p_store IS NULL OR s.store = p_store)
  )
  SELECT
    SUM(CASE WHEN bucket = 'OEM' THEN amount ELSE 0 END),
    SUM(CASE WHEN bucket = 'Local Agency' THEN amount ELSE 0 END),
    COUNT(DISTINCT CASE WHEN bucket = 'OEM' THEN invoice_no END),
    COUNT(DISTINCT CASE WHEN bucket = 'Local Agency' THEN invoice_no END)
  INTO v_oem_sales, v_loc_sales, v_oem_inv, v_loc_inv
  FROM joined;

  RETURN jsonb_build_object(
    'status', 'ok',
    'OEM',          jsonb_build_object('sales', COALESCE(v_oem_sales,0), 'invoices', COALESCE(v_oem_inv,0)),
    'Local_Agency', jsonb_build_object('sales', COALESCE(v_loc_sales,0), 'invoices', COALESCE(v_loc_inv,0)),
    'total',        COALESCE(v_oem_sales,0) + COALESCE(v_loc_sales,0));
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- After applying, optionally call once:
--   SELECT public.actions_sweep_overdue();
-- And schedule daily (Supabase cron OR Vercel cron hits
-- /api/sync?mode=actions_sweep_overdue with CRON_SECRET).
-- ═══════════════════════════════════════════════════════════════════════
