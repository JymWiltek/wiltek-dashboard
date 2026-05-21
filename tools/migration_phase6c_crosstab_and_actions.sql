-- ═══════════════════════════════════════════════════════════════════════
-- Wiltek Phase 6c — Customer 页 5+1 层重排 · 新增 年龄段 × 品类 cross-tab
-- ─────────────────────────────────────────────────────────────────────
-- Jym 问「这群顾客买什么」。本 RPC 把 customer_buy_lines 按
-- (会员入会龄段 × 品类 main_group) 聚合本月销售,前端 pivot 成矩阵。
-- 龄段 = AGE(本月1号, date_enrol): <1y / 1-5y / 5-8y / 8y+;date_enrol
-- 为空 → (unknown) 已剔除。
--
-- Action Plan (第 6 层) 的 5 个异常检测全部在前端用既有数据算
-- (matrix / payload.churn / 本 cross-tab / race target / age tiers),
-- 不需要新 RPC —— 故本迁移只含这一个 cross-tab 函数。
-- ═══════════════════════════════════════════════════════════════════════
-- TO APPLY: apply_migration / Claude-chat。幂等 (CREATE OR REPLACE)。
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.customer_age_category_crosstab(p_ym TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE v_rows JSONB;
BEGIN
  WITH age_buckets AS (
    SELECT
      cbl.main_group AS category,
      cbl.amt,
      CASE
        WHEN cbl.date_enrol IS NULL THEN '(unknown)'
        WHEN AGE((cbl.year_month || '-01')::date, cbl.date_enrol) < INTERVAL '1 year' THEN '<1y'
        WHEN AGE((cbl.year_month || '-01')::date, cbl.date_enrol) < INTERVAL '5 year' THEN '1-5y'
        WHEN AGE((cbl.year_month || '-01')::date, cbl.date_enrol) < INTERVAL '8 year' THEN '5-8y'
        ELSE '8y+'
      END AS age_bucket
    FROM public.customer_buy_lines cbl
    WHERE cbl.year_month = p_ym
      AND cbl.main_group IS NOT NULL AND cbl.main_group <> ''
  )
  SELECT jsonb_agg(jsonb_build_object(
    'age_bucket', age_bucket,
    'category',   category,
    'sales',      sales,
    'rows',       rows_cnt
  )) INTO v_rows
  FROM (
    SELECT age_bucket, category,
           SUM(amt)::numeric(14,2) AS sales,
           COUNT(*) AS rows_cnt
    FROM age_buckets
    WHERE age_bucket <> '(unknown)'
    GROUP BY age_bucket, category
    ORDER BY age_bucket, sales DESC
  ) t;

  RETURN jsonb_build_object('status', 'ok', 'rows', COALESCE(v_rows, '[]'::jsonb));
END $$;

COMMIT;

-- Quick check:
--   SELECT public.customer_age_category_crosstab('2026-04');
