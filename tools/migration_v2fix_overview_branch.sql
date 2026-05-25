-- ═══════════════════════════════════════════════════════════════════════
-- V2 Launch Fix 件1 — overview_kpi gains optional p_branch (manager parity)
-- ═══════════════════════════════════════════════════════════════════════
-- Adds store-scope to the 4-KPI overview hero so store managers see THEIR
-- store's Sales / Walk-in / Closing / Basket (same shape as owner company view).
--
-- byte-match guarantee: p_branch IS NULL → every WHERE clause is unfiltered →
-- output IDENTICAL to the previous overview_kpi(p_ym) company aggregate.
-- p_branch = 'W05' → each source filtered to that store.
--
-- _ov_kpi_block helper unchanged. Idempotent. Apply in one transaction.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- Drop the 1-arg version so the new defaulted 2-arg is unambiguous for PostgREST.
DROP FUNCTION IF EXISTS public.overview_kpi(text);

CREATE OR REPLACE FUNCTION public.overview_kpi(p_ym TEXT, p_branch TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_prev_ym TEXT := TO_CHAR((p_ym || '-01')::date - INTERVAL '1 month', 'YYYY-MM');
  v_sales NUMERIC; v_inv INT; v_sales_prev NUMERIC; v_inv_prev INT;
  v_walk NUMERIC; v_closed NUMERIC; v_walk_prev NUMERIC; v_closed_prev NUMERIC;
  v_t_sales NUMERIC; v_t_footfall NUMERIC; v_t_cr NUMERIC; v_t_basket NUMERIC;
  v_cr NUMERIC; v_cr_prev NUMERIC; v_basket NUMERIC; v_basket_prev NUMERIC;
BEGIN
  SELECT SUM(sales), SUM(invoices)::INT INTO v_sales, v_inv
    FROM public.mv_sales_kpi_monthly
    WHERE ym = p_ym AND (p_branch IS NULL OR store = p_branch);
  SELECT SUM(sales), SUM(invoices)::INT INTO v_sales_prev, v_inv_prev
    FROM public.mv_sales_kpi_monthly
    WHERE ym = v_prev_ym AND (p_branch IS NULL OR store = p_branch);

  SELECT COALESCE(SUM(walk_in_total),0), COALESCE(SUM(closed_count),0) INTO v_walk, v_closed
    FROM public.floatation
    WHERE TO_CHAR(date,'YYYY-MM') = p_ym AND (p_branch IS NULL OR store = p_branch);
  SELECT COALESCE(SUM(walk_in_total),0), COALESCE(SUM(closed_count),0) INTO v_walk_prev, v_closed_prev
    FROM public.floatation
    WHERE TO_CHAR(date,'YYYY-MM') = v_prev_ym AND (p_branch IS NULL OR store = p_branch);

  SELECT COALESCE(SUM(target_value),0) INTO v_t_sales
    FROM public.monthly_targets WHERE ym=p_ym AND target_type='sales'    AND (p_branch IS NULL OR store = p_branch);
  SELECT COALESCE(SUM(target_value),0) INTO v_t_footfall
    FROM public.monthly_targets WHERE ym=p_ym AND target_type='footfall' AND (p_branch IS NULL OR store = p_branch);
  SELECT AVG(target_value) INTO v_t_cr
    FROM public.monthly_targets WHERE ym=p_ym AND target_type='closing_rate' AND (p_branch IS NULL OR store = p_branch);
  SELECT AVG(target_value) INTO v_t_basket
    FROM public.monthly_targets WHERE ym=p_ym AND target_type='basket_size'  AND (p_branch IS NULL OR store = p_branch);

  v_cr          := CASE WHEN v_walk>0      THEN ROUND(v_closed/v_walk*100,1) ELSE NULL END;
  v_cr_prev     := CASE WHEN v_walk_prev>0 THEN ROUND(v_closed_prev/v_walk_prev*100,1) ELSE NULL END;
  v_basket      := CASE WHEN v_inv>0       THEN ROUND(v_sales/v_inv,2) ELSE NULL END;
  v_basket_prev := CASE WHEN v_inv_prev>0  THEN ROUND(v_sales_prev/v_inv_prev,2) ELSE NULL END;

  RETURN jsonb_build_object('month', p_ym, 'branch_scope', COALESCE(p_branch,'all'), 'kpis', jsonb_build_object(
    'sales',        public._ov_kpi_block(v_sales,  NULLIF(v_t_sales,0),    v_sales_prev),
    'walkin',       public._ov_kpi_block(v_walk,   NULLIF(v_t_footfall,0), v_walk_prev),
    'closing_rate', public._ov_kpi_block(v_cr,     v_t_cr,                 v_cr_prev),
    'basket_size',  public._ov_kpi_block(v_basket, v_t_basket,             v_basket_prev)));
END $$;

COMMIT;
