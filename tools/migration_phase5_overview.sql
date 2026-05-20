-- ═══════════════════════════════════════════════════════════════════════
-- Wiltek Phase 5 — Owner Overview (4-KPI hero)
-- Migration: monthly_targets CHECK widen + overview_kpi(p_ym) RPC
-- ═══════════════════════════════════════════════════════════════════════
-- TO APPLY: Claude-chat via Supabase MCP (single transaction). Idempotent.
-- Frontend degrades gracefully (banner) if not yet applied.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A: widen monthly_targets.target_type CHECK ──────────────────────────
-- Existing: IN ('sales','footfall'). Overview needs closing_rate +
-- basket_size targets too. Drop existing check (by either common name) then
-- add the wide one.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monthly_targets_target_type_check') THEN
    ALTER TABLE public.monthly_targets DROP CONSTRAINT monthly_targets_target_type_check;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monthly_targets_type_chk') THEN
    ALTER TABLE public.monthly_targets DROP CONSTRAINT monthly_targets_type_chk;
  END IF;
END $$;

ALTER TABLE public.monthly_targets
  ADD CONSTRAINT monthly_targets_type_chk
  CHECK (target_type IN ('sales','footfall','closing_rate','basket_size'));

-- ── B1: KPI block helper ────────────────────────────────────────────────
-- Packages one KPI: actual / target / pct / shortfall / vs_last_month_pct /
-- status. status thresholds (pct = actual/target*100):
--   >=100 green / 80-99 amber / 50-79 red / <50 darkred / null → gray
CREATE OR REPLACE FUNCTION public._ov_kpi_block(
  p_actual NUMERIC,
  p_target NUMERIC,
  p_prev   NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_pct NUMERIC;
  v_status TEXT;
  v_vs_lm NUMERIC;
BEGIN
  v_pct := CASE WHEN p_target IS NOT NULL AND p_target > 0
                THEN ROUND(p_actual / p_target * 100, 1) ELSE NULL END;
  v_status := CASE
                WHEN v_pct IS NULL THEN 'gray'
                WHEN v_pct >= 100  THEN 'green'
                WHEN v_pct >= 80   THEN 'amber'
                WHEN v_pct >= 50   THEN 'red'
                ELSE 'darkred' END;
  v_vs_lm := CASE WHEN p_prev IS NOT NULL AND p_prev <> 0
                  THEN ROUND((p_actual - p_prev) / ABS(p_prev) * 100, 1) ELSE NULL END;
  RETURN jsonb_build_object(
    'actual',            p_actual,
    'target',            p_target,
    'pct',               v_pct,
    'shortfall',         CASE WHEN p_target IS NOT NULL THEN p_target - p_actual ELSE NULL END,
    'vs_last_month_pct', v_vs_lm,
    'status',            v_status
  );
END $$;

-- ── B2: overview_kpi(p_ym) ──────────────────────────────────────────────
-- 4 owner-overview KPIs. Data sources:
--   sales        → mv_sales_kpi_monthly (sales, invoices)
--   walkin       → SUM(floatation.walk_in_total) for the month
--   closing_rate → SUM(closed_count) / SUM(walk_in_total) * 100
--   basket_size  → sales / invoices (AOV)
--   targets      → monthly_targets: sales/footfall = SUM; closing_rate/
--                  basket_size = AVG (per-store targets)
CREATE OR REPLACE FUNCTION public.overview_kpi(p_ym TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_prev_ym TEXT := TO_CHAR((p_ym || '-01')::date - INTERVAL '1 month', 'YYYY-MM');
  v_sales NUMERIC; v_inv INT; v_sales_prev NUMERIC; v_inv_prev INT;
  v_walk NUMERIC; v_closed NUMERIC; v_walk_prev NUMERIC; v_closed_prev NUMERIC;
  v_t_sales NUMERIC; v_t_footfall NUMERIC; v_t_cr NUMERIC; v_t_basket NUMERIC;
  v_cr NUMERIC; v_cr_prev NUMERIC;
  v_basket NUMERIC; v_basket_prev NUMERIC;
BEGIN
  SELECT sales, invoices INTO v_sales, v_inv
    FROM public.mv_sales_kpi_monthly WHERE ym = p_ym;
  SELECT sales, invoices INTO v_sales_prev, v_inv_prev
    FROM public.mv_sales_kpi_monthly WHERE ym = v_prev_ym;

  SELECT COALESCE(SUM(walk_in_total),0), COALESCE(SUM(closed_count),0)
    INTO v_walk, v_closed
    FROM public.floatation WHERE TO_CHAR(date, 'YYYY-MM') = p_ym;
  SELECT COALESCE(SUM(walk_in_total),0), COALESCE(SUM(closed_count),0)
    INTO v_walk_prev, v_closed_prev
    FROM public.floatation WHERE TO_CHAR(date, 'YYYY-MM') = v_prev_ym;

  SELECT COALESCE(SUM(target_value),0) INTO v_t_sales
    FROM public.monthly_targets WHERE ym = p_ym AND target_type = 'sales';
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
      'sales',        public._ov_kpi_block(v_sales,  NULLIF(v_t_sales,0),    v_sales_prev),
      'walkin',       public._ov_kpi_block(v_walk,   NULLIF(v_t_footfall,0), v_walk_prev),
      'closing_rate', public._ov_kpi_block(v_cr,     v_t_cr,                 v_cr_prev),
      'basket_size',  public._ov_kpi_block(v_basket, v_t_basket,             v_basket_prev)
    )
  );
END $$;

COMMIT;

-- Quick check after apply:
--   SELECT public.overview_kpi('2026-04');
