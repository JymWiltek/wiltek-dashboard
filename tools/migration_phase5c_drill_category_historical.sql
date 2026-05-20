-- ═══════════════════════════════════════════════════════════════════════
-- Wiltek Phase 5c — 品类 drill historical comparisons
-- Enhance sales_drill_category with vs-last-month / vs-last-year /
-- vs-12mo-avg per category (parity with customer_type + supplier in 5b).
-- ═══════════════════════════════════════════════════════════════════════
-- TO APPLY: Claude-chat via Supabase MCP. Idempotent (CREATE OR REPLACE).
-- 撞墙拍板: comparisons SERVER-SIDE (13-month window + CTE, 1 round-trip).
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

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
  v_prev_ym TEXT := TO_CHAR((p_ym || '-01')::date - INTERVAL '1 month', 'YYYY-MM');
  v_ly_ym   TEXT := TO_CHAR((p_ym || '-01')::date - INTERVAL '1 year',  'YYYY-MM');
  v_rows    JSONB;
BEGIN
  SELECT COUNT(*) INTO v_nonnull
    FROM public.items WHERE main_group IS NOT NULL AND main_group <> '';
  IF v_nonnull = 0 THEN
    RETURN jsonb_build_object(
      'status',  'data_gap',
      'message', '品类拆分需 items.main_group, 暂未接入 / 全部为空');
  END IF;

  WITH base AS (
    SELECT COALESCE(NULLIF(i.main_group, ''), '(未分类)') AS category,
           TO_CHAR(s.sale_date, 'YYYY-MM')                AS ym,
           s.amount, s.qty, s.invoice_no
      FROM public.sales s
      JOIN public.items i ON i.item_code = s.item_code
     WHERE s.sale_date >= (p_ym || '-01')::date - INTERVAL '12 month'
       AND s.sale_date <  (p_ym || '-01')::date + INTERVAL '1 month'
       AND (p_store IS NULL OR s.store = p_store)
  ),
  by_ym AS (
    SELECT category, ym,
           SUM(amount)             AS sales,
           COUNT(DISTINCT invoice_no) AS invoices,
           SUM(qty)                AS units
      FROM base GROUP BY category, ym
  ),
  cur AS (SELECT category, sales, invoices, units FROM by_ym WHERE ym = p_ym),
  prv AS (SELECT category, sales FROM by_ym WHERE ym = v_prev_ym),
  ly  AS (SELECT category, sales FROM by_ym WHERE ym = v_ly_ym),
  a12 AS (SELECT category, AVG(sales) AS s FROM by_ym WHERE ym < p_ym GROUP BY category)
  SELECT jsonb_agg(jsonb_build_object(
           'category',        cur.category,
           'sales',           ROUND(cur.sales, 2),
           'invoices',        cur.invoices,
           'units',           cur.units,
           'aov',             CASE WHEN cur.invoices > 0 THEN ROUND(cur.sales / cur.invoices, 2) ELSE NULL END,
           'sales_prev',      ROUND(prv.sales, 2),
           'sales_last_year', ROUND(ly.sales, 2),
           'sales_12mo_avg',  ROUND(a12.s, 2)
         ) ORDER BY cur.sales DESC) INTO v_rows
    FROM cur
    LEFT JOIN prv ON prv.category = cur.category
    LEFT JOIN ly  ON ly.category  = cur.category
    LEFT JOIN a12 ON a12.category = cur.category;

  -- keep top 20 by sales (jsonb_agg already ordered; slice client-side OK,
  -- but trim here to bound payload)
  RETURN jsonb_build_object('status', 'ok',
    'rows', COALESCE((SELECT jsonb_agg(e) FROM (
              SELECT e FROM jsonb_array_elements(v_rows) e LIMIT 20
            ) t), '[]'::jsonb));
END $$;

COMMIT;

-- Quick check:
--   SELECT public.sales_drill_category('2026-04', NULL);
