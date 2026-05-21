-- ═══════════════════════════════════════════════════════════════════════
-- Wiltek Phase 6 — Customer page (Owner BI · Tier 1) · 5 RPCs
-- ═══════════════════════════════════════════════════════════════════════
-- TO APPLY: Claude-chat via Supabase MCP (single transaction). Idempotent.
-- Depends on _ov_kpi_block() from migration_phase5_overview.sql (re-defined
-- here defensively so phase6 can apply standalone).
--
-- Data sources (authoritative columns, parser-guaranteed):
--   floatation: store, date, walk_in_total, walk_in_chinese/malay/indian/other,
--               closed_count, closing_rate, amount_total, basket_total,
--               by_race jsonb { chinese|malay|indian|others: {purchase, amount} }
--   customer_buy_lines: year_month ('YYYY-MM'), branch, member_code, qty, amt,
--               cust_type, date_enrol, main_group
--   mv_sales_kpi_monthly: ym, sales, invoices
--   monthly_targets: ym, store, target_type, target_value
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- Defensive re-create of the KPI block helper (same as phase5).
CREATE OR REPLACE FUNCTION public._ov_kpi_block(
  p_actual NUMERIC, p_target NUMERIC, p_prev NUMERIC
) RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_pct NUMERIC; v_status TEXT; v_vs_lm NUMERIC;
BEGIN
  v_pct := CASE WHEN p_target IS NOT NULL AND p_target > 0
                THEN ROUND(p_actual / p_target * 100, 1) ELSE NULL END;
  v_status := CASE WHEN v_pct IS NULL THEN 'gray'
                WHEN v_pct >= 100 THEN 'green'
                WHEN v_pct >= 80  THEN 'amber'
                WHEN v_pct >= 50  THEN 'red'
                ELSE 'darkred' END;
  v_vs_lm := CASE WHEN p_prev IS NOT NULL AND p_prev <> 0
                  THEN ROUND((p_actual - p_prev) / ABS(p_prev) * 100, 1) ELSE NULL END;
  RETURN jsonb_build_object(
    'actual', p_actual, 'target', p_target, 'pct', v_pct,
    'shortfall', CASE WHEN p_target IS NOT NULL THEN p_target - p_actual ELSE NULL END,
    'vs_last_month_pct', v_vs_lm, 'status', v_status);
END $$;

-- ── RPC 1: customer_overview_kpi(p_ym) — 4 KPI hero ────────────────────
CREATE OR REPLACE FUNCTION public.customer_overview_kpi(p_ym TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_prev_ym TEXT := TO_CHAR((p_ym || '-01')::date - INTERVAL '1 month', 'YYYY-MM');
  v_walk NUMERIC; v_closed NUMERIC; v_rev NUMERIC;
  v_walk_prev NUMERIC; v_closed_prev NUMERIC; v_rev_prev NUMERIC;
  v_sales NUMERIC; v_inv INT; v_sales_prev NUMERIC; v_inv_prev INT;
  v_t_footfall NUMERIC; v_t_cr NUMERIC; v_t_basket NUMERIC;
  v_cr NUMERIC; v_cr_prev NUMERIC; v_basket NUMERIC; v_basket_prev NUMERIC;
BEGIN
  SELECT COALESCE(SUM(walk_in_total),0), COALESCE(SUM(closed_count),0), COALESCE(SUM(amount_total),0)
    INTO v_walk, v_closed, v_rev
    FROM public.floatation WHERE TO_CHAR(date,'YYYY-MM') = p_ym;
  SELECT COALESCE(SUM(walk_in_total),0), COALESCE(SUM(closed_count),0), COALESCE(SUM(amount_total),0)
    INTO v_walk_prev, v_closed_prev, v_rev_prev
    FROM public.floatation WHERE TO_CHAR(date,'YYYY-MM') = v_prev_ym;

  SELECT sales, invoices INTO v_sales, v_inv FROM public.mv_sales_kpi_monthly WHERE ym = p_ym;
  SELECT sales, invoices INTO v_sales_prev, v_inv_prev FROM public.mv_sales_kpi_monthly WHERE ym = v_prev_ym;

  SELECT COALESCE(SUM(target_value),0) INTO v_t_footfall
    FROM public.monthly_targets WHERE ym = p_ym AND target_type = 'footfall';
  SELECT AVG(target_value) INTO v_t_cr
    FROM public.monthly_targets WHERE ym = p_ym AND target_type = 'closing_rate';
  SELECT AVG(target_value) INTO v_t_basket
    FROM public.monthly_targets WHERE ym = p_ym AND target_type = 'basket_size';

  v_cr          := CASE WHEN v_walk > 0      THEN ROUND(v_closed / v_walk * 100, 1) ELSE NULL END;
  v_cr_prev     := CASE WHEN v_walk_prev > 0 THEN ROUND(v_closed_prev / v_walk_prev * 100, 1) ELSE NULL END;
  v_basket      := CASE WHEN v_inv > 0       THEN ROUND(v_sales / v_inv, 2) ELSE NULL END;
  v_basket_prev := CASE WHEN v_inv_prev > 0  THEN ROUND(v_sales_prev / v_inv_prev, 2) ELSE NULL END;

  RETURN jsonb_build_object(
    'month', p_ym,
    'kpis', jsonb_build_object(
      'walkin',              public._ov_kpi_block(v_walk,   NULLIF(v_t_footfall,0), v_walk_prev),
      'closing_rate',        public._ov_kpi_block(v_cr,     v_t_cr,                 v_cr_prev),
      'basket_size',         public._ov_kpi_block(v_basket, v_t_basket,             v_basket_prev),
      'revenue_from_walkin', public._ov_kpi_block(v_rev,    NULL,                   v_rev_prev)
    )
  );
END $$;

-- ── RPC 2: customer_by_race(p_ym, p_store) — 4 race breakdown ──────────
CREATE OR REPLACE FUNCTION public.customer_by_race(
  p_ym    TEXT,
  p_store TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_rows JSONB;
  v_tot_walk NUMERIC; v_tot_pur NUMERIC; v_tot_rev NUMERIC;
BEGIN
  WITH f AS (
    SELECT * FROM public.floatation
     WHERE TO_CHAR(date,'YYYY-MM') = p_ym
       AND (p_store IS NULL OR store = p_store)
  ),
  agg AS (
    SELECT
      -- walk-in from columns
      COALESCE(SUM(walk_in_chinese),0) AS w_ch,
      COALESCE(SUM(walk_in_malay),0)   AS w_my,
      COALESCE(SUM(walk_in_indian),0)  AS w_in,
      COALESCE(SUM(walk_in_other),0)   AS w_ot,
      -- purchases + revenue from by_race jsonb (key 'others' for other)
      COALESCE(SUM((by_race->'chinese'->>'purchase')::numeric),0) AS p_ch,
      COALESCE(SUM((by_race->'malay'->>'purchase')::numeric),0)   AS p_my,
      COALESCE(SUM((by_race->'indian'->>'purchase')::numeric),0)  AS p_in,
      COALESCE(SUM((by_race->'others'->>'purchase')::numeric),0)  AS p_ot,
      COALESCE(SUM((by_race->'chinese'->>'amount')::numeric),0)   AS r_ch,
      COALESCE(SUM((by_race->'malay'->>'amount')::numeric),0)     AS r_my,
      COALESCE(SUM((by_race->'indian'->>'amount')::numeric),0)    AS r_in,
      COALESCE(SUM((by_race->'others'->>'amount')::numeric),0)    AS r_ot
    FROM f
  )
  SELECT
    (a.w_ch + a.w_my + a.w_in + a.w_ot),
    (a.p_ch + a.p_my + a.p_in + a.p_ot),
    (a.r_ch + a.r_my + a.r_in + a.r_ot)
  INTO v_tot_walk, v_tot_pur, v_tot_rev FROM agg a;

  WITH agg AS (
    SELECT
      COALESCE(SUM(walk_in_chinese),0) AS w_ch, COALESCE(SUM(walk_in_malay),0) AS w_my,
      COALESCE(SUM(walk_in_indian),0)  AS w_in, COALESCE(SUM(walk_in_other),0) AS w_ot,
      COALESCE(SUM((by_race->'chinese'->>'purchase')::numeric),0) AS p_ch,
      COALESCE(SUM((by_race->'malay'->>'purchase')::numeric),0)   AS p_my,
      COALESCE(SUM((by_race->'indian'->>'purchase')::numeric),0)  AS p_in,
      COALESCE(SUM((by_race->'others'->>'purchase')::numeric),0)  AS p_ot,
      COALESCE(SUM((by_race->'chinese'->>'amount')::numeric),0)   AS r_ch,
      COALESCE(SUM((by_race->'malay'->>'amount')::numeric),0)     AS r_my,
      COALESCE(SUM((by_race->'indian'->>'amount')::numeric),0)    AS r_in,
      COALESCE(SUM((by_race->'others'->>'amount')::numeric),0)    AS r_ot
    FROM public.floatation
    WHERE TO_CHAR(date,'YYYY-MM') = p_ym AND (p_store IS NULL OR store = p_store)
  )
  SELECT jsonb_build_array(
    public._cust_race_row('chinese', a.w_ch, a.p_ch, a.r_ch, v_tot_walk, v_tot_rev),
    public._cust_race_row('malay',   a.w_my, a.p_my, a.r_my, v_tot_walk, v_tot_rev),
    public._cust_race_row('indian',  a.w_in, a.p_in, a.r_in, v_tot_walk, v_tot_rev),
    public._cust_race_row('other',   a.w_ot, a.p_ot, a.r_ot, v_tot_walk, v_tot_rev)
  ) INTO v_rows FROM agg a;

  RETURN jsonb_build_object(
    'month', p_ym,
    'races', v_rows,
    'total', jsonb_build_object(
      'walkin', v_tot_walk, 'purchases', v_tot_pur, 'revenue', ROUND(v_tot_rev,2),
      'closing_rate', CASE WHEN v_tot_walk>0 THEN ROUND(v_tot_pur/v_tot_walk*100,1) ELSE NULL END,
      'avg_basket',   CASE WHEN v_tot_pur>0 THEN ROUND(v_tot_rev/v_tot_pur,2) ELSE NULL END)
  );
END $$;

-- helper: one race row
CREATE OR REPLACE FUNCTION public._cust_race_row(
  p_race TEXT, p_walk NUMERIC, p_pur NUMERIC, p_rev NUMERIC,
  p_tot_walk NUMERIC, p_tot_rev NUMERIC
) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'race', p_race,
    'walkin', p_walk,
    'walkin_pct', CASE WHEN p_tot_walk>0 THEN ROUND(p_walk/p_tot_walk*100,1) ELSE NULL END,
    'purchases', p_pur,
    'closing_rate', CASE WHEN p_walk>0 THEN ROUND(p_pur/p_walk*100,1) ELSE NULL END,
    'revenue', ROUND(p_rev,2),
    'revenue_pct', CASE WHEN p_tot_rev>0 THEN ROUND(p_rev/p_tot_rev*100,1) ELSE NULL END,
    'avg_basket', CASE WHEN p_pur>0 THEN ROUND(p_rev/p_pur,2) ELSE NULL END);
$$;

-- ── RPC 3: customer_store_race_matrix(p_ym) — per store × 4 race ───────
CREATE OR REPLACE FUNCTION public.customer_store_race_matrix(p_ym TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE v_matrix JSONB;
BEGIN
  WITH per AS (
    SELECT store,
      COALESCE(SUM(walk_in_chinese),0) AS w_ch, COALESCE(SUM(walk_in_malay),0) AS w_my,
      COALESCE(SUM(walk_in_indian),0)  AS w_in, COALESCE(SUM(walk_in_other),0) AS w_ot,
      COALESCE(SUM((by_race->'chinese'->>'purchase')::numeric),0) AS p_ch,
      COALESCE(SUM((by_race->'malay'->>'purchase')::numeric),0)   AS p_my,
      COALESCE(SUM((by_race->'indian'->>'purchase')::numeric),0)  AS p_in,
      COALESCE(SUM((by_race->'others'->>'purchase')::numeric),0)  AS p_ot,
      COALESCE(SUM((by_race->'chinese'->>'amount')::numeric),0)   AS r_ch,
      COALESCE(SUM((by_race->'malay'->>'amount')::numeric),0)     AS r_my,
      COALESCE(SUM((by_race->'indian'->>'amount')::numeric),0)    AS r_in,
      COALESCE(SUM((by_race->'others'->>'amount')::numeric),0)    AS r_ot,
      COALESCE(SUM(walk_in_total),0) AS w_tot
    FROM public.floatation
    WHERE TO_CHAR(date,'YYYY-MM') = p_ym
    GROUP BY store
  )
  SELECT jsonb_agg(jsonb_build_object(
    'store', store,
    'chinese', jsonb_build_object('walkin',w_ch,'purchases',p_ch,'revenue',ROUND(r_ch,2),'closing_rate',CASE WHEN w_ch>0 THEN ROUND(p_ch/w_ch*100,1) ELSE NULL END),
    'malay',   jsonb_build_object('walkin',w_my,'purchases',p_my,'revenue',ROUND(r_my,2),'closing_rate',CASE WHEN w_my>0 THEN ROUND(p_my/w_my*100,1) ELSE NULL END),
    'indian',  jsonb_build_object('walkin',w_in,'purchases',p_in,'revenue',ROUND(r_in,2),'closing_rate',CASE WHEN w_in>0 THEN ROUND(p_in/w_in*100,1) ELSE NULL END),
    'other',   jsonb_build_object('walkin',w_ot,'purchases',p_ot,'revenue',ROUND(r_ot,2),'closing_rate',CASE WHEN w_ot>0 THEN ROUND(p_ot/w_ot*100,1) ELSE NULL END),
    'total_walkin', w_tot
  ) ORDER BY store) INTO v_matrix FROM per;

  RETURN jsonb_build_object('month', p_ym, 'matrix', COALESCE(v_matrix,'[]'::jsonb));
END $$;

-- ── RPC 4: customer_trend(p_ym) — 12M walk-in/closing/basket/revenue ───
CREATE OR REPLACE FUNCTION public.customer_trend(p_ym TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE v_series JSONB;
BEGIN
  WITH f AS (
    SELECT TO_CHAR(date,'YYYY-MM') AS ym,
           SUM(walk_in_total) AS walk, SUM(closed_count) AS closed, SUM(amount_total) AS rev
      FROM public.floatation
     WHERE date >= (p_ym || '-01')::date - INTERVAL '11 month'
       AND date <  (p_ym || '-01')::date + INTERVAL '1 month'
     GROUP BY 1
  ),
  s AS (
    SELECT ym, sales, invoices FROM public.mv_sales_kpi_monthly
     WHERE ym >= TO_CHAR((p_ym || '-01')::date - INTERVAL '11 month','YYYY-MM')
       AND ym <= p_ym
  )
  SELECT jsonb_agg(jsonb_build_object(
           'ym', m.ym,
           'walkin', COALESCE(f.walk,0),
           'closing_rate', CASE WHEN f.walk>0 THEN ROUND(f.closed/f.walk*100,1) ELSE NULL END,
           'revenue', ROUND(COALESCE(f.rev,0),2),
           'basket', CASE WHEN s.invoices>0 THEN ROUND(s.sales/s.invoices,2) ELSE NULL END
         ) ORDER BY m.ym) INTO v_series
    FROM (
      SELECT TO_CHAR((p_ym || '-01')::date - (n || ' month')::interval, 'YYYY-MM') AS ym
        FROM generate_series(0,11) n
    ) m
    LEFT JOIN f ON f.ym = m.ym
    LEFT JOIN s ON s.ym = m.ym;

  RETURN jsonb_build_object('month', p_ym, 'series', COALESCE(v_series,'[]'::jsonb));
END $$;

-- ── RPC 5: customer_member_analysis(p_ym) — cust_type / old-new / member% ─
-- Uses customer_buy_lines authoritative columns: year_month, member_code,
-- amt, cust_type, date_enrol. NO joins (cust_type is on cbl directly).
CREATE OR REPLACE FUNCTION public.customer_member_analysis(p_ym TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_has INT;
  v_types JSONB;
  v_member_rows INT; v_total_rows INT;
  v_new_amt NUMERIC; v_old_amt NUMERIC;
BEGIN
  SELECT COUNT(*) INTO v_has FROM public.customer_buy_lines WHERE year_month = p_ym;
  IF v_has = 0 THEN
    RETURN jsonb_build_object('status','data_gap',
      'message','customer_buy_lines 本月无数据, 客型分析无法计算');
  END IF;

  -- cust_type breakdown
  WITH t AS (
    SELECT COALESCE(NULLIF(cust_type,''),'(unknown)') AS cust_type,
           COUNT(DISTINCT member_code) AS members,
           SUM(amt) AS sales, COUNT(*) AS rows
      FROM public.customer_buy_lines WHERE year_month = p_ym
     GROUP BY 1
  )
  SELECT jsonb_agg(jsonb_build_object(
           'cust_type', cust_type, 'members', members,
           'sales', ROUND(sales,2), 'rows', rows
         ) ORDER BY sales DESC) INTO v_types FROM t;

  -- member % (member_code non-empty)
  SELECT COUNT(*) FILTER (WHERE member_code IS NOT NULL AND member_code <> ''),
         COUNT(*)
    INTO v_member_rows, v_total_rows
    FROM public.customer_buy_lines WHERE year_month = p_ym;

  -- old vs new (date_enrol within this month = new; before = old)
  SELECT
    COALESCE(SUM(amt) FILTER (WHERE date_enrol >= (p_ym||'-01')::date),0),
    COALESCE(SUM(amt) FILTER (WHERE date_enrol <  (p_ym||'-01')::date OR date_enrol IS NULL),0)
    INTO v_new_amt, v_old_amt
    FROM public.customer_buy_lines WHERE year_month = p_ym;

  RETURN jsonb_build_object(
    'status','ok',
    'cust_types', COALESCE(v_types,'[]'::jsonb),
    'member_pct', CASE WHEN v_total_rows>0 THEN ROUND(v_member_rows::numeric/v_total_rows*100,1) ELSE NULL END,
    'member_rows', v_member_rows, 'total_rows', v_total_rows,
    'new_customer_sales', ROUND(v_new_amt,2),
    'old_customer_sales', ROUND(v_old_amt,2)
  );
END $$;

COMMIT;

-- Quick checks:
--   SELECT public.customer_overview_kpi('2026-04');
--   SELECT public.customer_by_race('2026-04', NULL);
--   SELECT public.customer_store_race_matrix('2026-04');
--   SELECT public.customer_trend('2026-04');
--   SELECT public.customer_member_analysis('2026-04');
