-- ═══════════════════════════════════════════════════════════════════════
-- Wiltek Phase 5b — Drill Cross-cut historical comparisons
-- Enhance sales_drill_customer_type + sales_drill_supplier with
-- vs-last-month / vs-last-year / vs-12mo-avg per row.
-- ═══════════════════════════════════════════════════════════════════════
-- TO APPLY: Claude-chat via Supabase MCP (single transaction). Idempotent
-- (CREATE OR REPLACE). Frontend reads new fields; missing → renders "—".
--
-- 撞墙拍板: comparisons computed SERVER-SIDE (1 round-trip per tab) instead
-- of the frontend firing 4 RPC calls × N months. Each RPC pulls a 13-month
-- window once and aggregates current / prev / last-year / 12mo-avg in CTEs.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── RPC: sales_drill_customer_type(p_ym, p_store) ───────────────────────
-- Per cust_type: sales + rows (current month) + sales_prev / sales_ly /
-- sales_12mo_avg (raw RM; frontend computes pct deltas, shows — when null).
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
  v_prev_ym TEXT := TO_CHAR((p_ym || '-01')::date - INTERVAL '1 month', 'YYYY-MM');
  v_ly_ym   TEXT := TO_CHAR((p_ym || '-01')::date - INTERVAL '1 year',  'YYYY-MM');
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

  WITH base AS (
    SELECT COALESCE(NULLIF(c.cust_type, ''), '(unknown)') AS cust_type,
           TO_CHAR(cbl.date, 'YYYY-MM')                   AS ym,
           cbl.amount
      FROM public.customer_buy_lines cbl
      LEFT JOIN public.customers c ON c.cust_id = cbl.cust_id
     WHERE cbl.date >= (p_ym || '-01')::date - INTERVAL '12 month'
       AND cbl.date <  (p_ym || '-01')::date + INTERVAL '1 month'
       AND (p_store IS NULL OR cbl.store = p_store)
  ),
  by_ym AS (
    SELECT cust_type, ym, SUM(amount) AS sales, COUNT(*) AS rows
      FROM base GROUP BY cust_type, ym
  ),
  cur AS (SELECT cust_type, sales, rows FROM by_ym WHERE ym = p_ym),
  prv AS (SELECT cust_type, sales FROM by_ym WHERE ym = v_prev_ym),
  ly  AS (SELECT cust_type, sales FROM by_ym WHERE ym = v_ly_ym),
  a12 AS (SELECT cust_type, AVG(sales) AS s FROM by_ym WHERE ym < p_ym GROUP BY cust_type)
  SELECT jsonb_agg(jsonb_build_object(
           'cust_type',      cur.cust_type,
           'sales',          ROUND(cur.sales, 2),
           'rows',           cur.rows,
           'sales_prev',     ROUND(prv.sales, 2),
           'sales_last_year',ROUND(ly.sales, 2),
           'sales_12mo_avg', ROUND(a12.s, 2)
         ) ORDER BY cur.sales DESC) INTO v_rows
    FROM cur
    LEFT JOIN prv ON prv.cust_type = cur.cust_type
    LEFT JOIN ly  ON ly.cust_type  = cur.cust_type
    LEFT JOIN a12 ON a12.cust_type = cur.cust_type;

  RETURN jsonb_build_object('status', 'ok', 'rows', COALESCE(v_rows, '[]'::jsonb));
END $$;

-- ── RPC: sales_drill_supplier(p_ym, p_store) — OEM vs Local Agency ──────
-- Per bucket: sales + invoices (current) + sales_prev / sales_ly /
-- sales_12mo_avg.
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
  v_prev_ym TEXT := TO_CHAR((p_ym || '-01')::date - INTERVAL '1 month', 'YYYY-MM');
  v_ly_ym   TEXT := TO_CHAR((p_ym || '-01')::date - INTERVAL '1 year',  'YYYY-MM');
  v_rows    JSONB;
BEGIN
  SELECT COUNT(*) INTO v_has_country
    FROM public.items WHERE country IS NOT NULL AND country <> '';
  IF v_has_country = 0 THEN
    RETURN jsonb_build_object(
      'status',  'data_gap',
      'message', 'items.country 字段全空, OEM/Agency 无法拆分');
  END IF;

  WITH base AS (
    SELECT CASE WHEN UPPER(COALESCE(i.country, '')) = 'CHINA' THEN 'OEM'
                WHEN UPPER(COALESCE(i.country, '')) IN ('MALAYSIA','LOCAL') THEN 'Local Agency'
                ELSE 'Other' END                  AS bucket,
           TO_CHAR(s.sale_date, 'YYYY-MM')        AS ym,
           s.amount, s.invoice_no
      FROM public.sales s
      JOIN public.items i ON i.item_code = s.item_code
     WHERE s.sale_date >= (p_ym || '-01')::date - INTERVAL '12 month'
       AND s.sale_date <  (p_ym || '-01')::date + INTERVAL '1 month'
       AND (p_store IS NULL OR s.store = p_store)
  ),
  by_ym AS (
    SELECT bucket, ym, SUM(amount) AS sales, COUNT(DISTINCT invoice_no) AS invoices
      FROM base GROUP BY bucket, ym
  ),
  cur AS (SELECT bucket, sales, invoices FROM by_ym WHERE ym = p_ym),
  prv AS (SELECT bucket, sales FROM by_ym WHERE ym = v_prev_ym),
  ly  AS (SELECT bucket, sales FROM by_ym WHERE ym = v_ly_ym),
  a12 AS (SELECT bucket, AVG(sales) AS s FROM by_ym WHERE ym < p_ym GROUP BY bucket)
  SELECT jsonb_agg(jsonb_build_object(
           'bucket',          cur.bucket,
           'sales',           ROUND(cur.sales, 2),
           'invoices',        cur.invoices,
           'sales_prev',      ROUND(prv.sales, 2),
           'sales_last_year', ROUND(ly.sales, 2),
           'sales_12mo_avg',  ROUND(a12.s, 2)
         ) ORDER BY cur.sales DESC) INTO v_rows
    FROM cur
    LEFT JOIN prv ON prv.bucket = cur.bucket
    LEFT JOIN ly  ON ly.bucket  = cur.bucket
    LEFT JOIN a12 ON a12.bucket = cur.bucket;

  RETURN jsonb_build_object('status', 'ok', 'rows', COALESCE(v_rows, '[]'::jsonb));
END $$;

COMMIT;

-- Quick check:
--   SELECT public.sales_drill_customer_type('2026-04', NULL);
--   SELECT public.sales_drill_supplier('2026-04', NULL);
