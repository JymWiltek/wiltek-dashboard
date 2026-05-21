-- ═══════════════════════════════════════════════════════════════════════
-- Wiltek Phase 6f — 种族 cards + 6 店×种族矩阵 加历史对比
-- ─────────────────────────────────────────────────────────────────────
-- floatation 有 2026-01..05 共 5 个月。诚实显 vs 上月 / vs 近 3 月均
-- (近 3 月 = 当月之前 3 个月的聚合)。去年同月无数据 → 前端显 —。
--
-- customer_by_race: 每族加 walkin_prev / walkin_3mo_avg / revenue_prev /
--   revenue_3mo_avg (保留既有 walkin_target / pct / 本月字段)。
-- customer_store_race_matrix: 每店每族加 walkin_prev / walkin_3mo_avg /
--   closing_prev / closing_3mo_avg (保留既有本月字段)。
--
-- 实现: 拉 4 个月窗口 [p_ym-3, p_ym], 用 LATERAL 把每行 floatation 拆成
-- 4 个种族长表, 再按 (ym, race[, store]) 聚合, FILTER 取当月/上月/近3月。
-- 3 月均的 closing 用聚合口径 (Σpur/Σwalk) 比平均月率更稳。
-- ═══════════════════════════════════════════════════════════════════════
-- TO APPLY: apply_migration / Claude-chat。幂等 (CREATE OR REPLACE)。
-- 前端读不到新字段时优雅降级 (显 —)。PART 2 (Targets race editor) 纯前端,
-- 后端 handleTargets / targets_upsert 已支持任意 target_type, 无需改。
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── RPC: customer_by_race(p_ym, p_store) + 历史 ────────────────────────
CREATE OR REPLACE FUNCTION public.customer_by_race(
  p_ym    TEXT,
  p_store TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_prev TEXT := TO_CHAR((p_ym || '-01')::date - INTERVAL '1 month', 'YYYY-MM');
  v_out JSONB;
  v_t   JSONB;
BEGIN
  -- 走廊客 target (公司层 = 各店求和; 指定店 = 该店)。
  SELECT jsonb_object_agg(target_type, v) INTO v_t FROM (
    SELECT target_type, SUM(target_value) AS v
      FROM public.monthly_targets
     WHERE ym = p_ym
       AND target_type IN ('walkin_chinese','walkin_malay','walkin_indian','walkin_other')
       AND (p_store IS NULL OR store = p_store)
     GROUP BY target_type
  ) tt;

  -- 单条语句构建整个返回对象 (CTE 只在本语句内有效)。
  WITH f AS (
    SELECT date, walk_in_chinese, walk_in_malay, walk_in_indian, walk_in_other, by_race
      FROM public.floatation
     WHERE date >= (p_ym || '-01')::date - INTERVAL '3 month'
       AND date <  (p_ym || '-01')::date + INTERVAL '1 month'
       AND (p_store IS NULL OR store = p_store)
  ),
  long AS (
    SELECT TO_CHAR(f.date,'YYYY-MM') AS ym, r.race,
           COALESCE(r.walkin,0) AS walkin, COALESCE(r.revenue,0) AS revenue, COALESCE(r.purchase,0) AS purchase
      FROM f CROSS JOIN LATERAL (VALUES
        ('chinese', f.walk_in_chinese, (f.by_race->'chinese'->>'amount')::numeric, (f.by_race->'chinese'->>'purchase')::numeric),
        ('malay',   f.walk_in_malay,   (f.by_race->'malay'->>'amount')::numeric,   (f.by_race->'malay'->>'purchase')::numeric),
        ('indian',  f.walk_in_indian,  (f.by_race->'indian'->>'amount')::numeric,  (f.by_race->'indian'->>'purchase')::numeric),
        ('other',   f.walk_in_other,   (f.by_race->'others'->>'amount')::numeric,  (f.by_race->'others'->>'purchase')::numeric)
      ) AS r(race, walkin, revenue, purchase)
  ),
  by_mr AS (
    SELECT ym, race, SUM(walkin) AS walkin, SUM(revenue) AS revenue, SUM(purchase) AS purchase
      FROM long GROUP BY ym, race
  ),
  agg AS (
    SELECT race,
      COALESCE(SUM(walkin)   FILTER (WHERE ym = p_ym),0)   AS cur_walk,
      COALESCE(SUM(purchase) FILTER (WHERE ym = p_ym),0)   AS cur_pur,
      COALESCE(SUM(revenue)  FILTER (WHERE ym = p_ym),0)   AS cur_rev,
      SUM(walkin)  FILTER (WHERE ym = v_prev) AS prev_walk,
      SUM(revenue) FILTER (WHERE ym = v_prev) AS prev_rev,
      AVG(walkin)  FILTER (WHERE ym < p_ym)   AS avg_walk,
      AVG(revenue) FILTER (WHERE ym < p_ym)   AS avg_rev
    FROM by_mr GROUP BY race
  ),
  agg_t AS (SELECT agg.*, NULLIF((v_t->>('walkin_'||agg.race))::numeric,0) AS tgt FROM agg),
  tot AS (SELECT COALESCE(SUM(cur_walk),0) AS tw, COALESCE(SUM(cur_pur),0) AS tp, COALESCE(SUM(cur_rev),0) AS tr FROM agg)
  SELECT jsonb_build_object(
    'month', p_ym,
    'races', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'race',              a.race,
          'walkin',            a.cur_walk,
          'walkin_pct',        CASE WHEN tot.tw>0 THEN ROUND(a.cur_walk/tot.tw*100,1) END,
          'purchases',         a.cur_pur,
          'closing_rate',      CASE WHEN a.cur_walk>0 THEN ROUND(a.cur_pur/a.cur_walk*100,1) END,
          'revenue',           ROUND(a.cur_rev,2),
          'revenue_pct',       CASE WHEN tot.tr>0 THEN ROUND(a.cur_rev/tot.tr*100,1) END,
          'avg_basket',        CASE WHEN a.cur_pur>0 THEN ROUND(a.cur_rev/a.cur_pur,2) END,
          'walkin_target',     a.tgt,
          'walkin_target_pct', CASE WHEN a.tgt>0 THEN ROUND(a.cur_walk/a.tgt*100,1) END,
          'walkin_prev',       a.prev_walk,
          'walkin_3mo_avg',    ROUND(a.avg_walk,1),
          'revenue_prev',      ROUND(a.prev_rev,2),
          'revenue_3mo_avg',   ROUND(a.avg_rev,2)
        ) ORDER BY array_position(ARRAY['chinese','malay','indian','other'], a.race)
      ) FROM agg_t a CROSS JOIN tot
    ), '[]'::jsonb),
    'total', (SELECT jsonb_build_object(
        'walkin', tot.tw, 'purchases', tot.tp, 'revenue', ROUND(tot.tr,2),
        'closing_rate', CASE WHEN tot.tw>0 THEN ROUND(tot.tp/tot.tw*100,1) END,
        'avg_basket',   CASE WHEN tot.tp>0 THEN ROUND(tot.tr/tot.tp,2) END,
        'walkin_target', NULLIF(COALESCE((v_t->>'walkin_chinese')::numeric,0)
                              + COALESCE((v_t->>'walkin_malay')::numeric,0)
                              + COALESCE((v_t->>'walkin_indian')::numeric,0)
                              + COALESCE((v_t->>'walkin_other')::numeric,0),0)
      ) FROM tot)
  ) INTO v_out;

  RETURN v_out;
END $$;

-- ── RPC: customer_store_race_matrix(p_ym) + 历史 ───────────────────────
CREATE OR REPLACE FUNCTION public.customer_store_race_matrix(p_ym TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_prev TEXT := TO_CHAR((p_ym || '-01')::date - INTERVAL '1 month', 'YYYY-MM');
  v_matrix JSONB;
BEGIN
  WITH f AS (
    SELECT TO_CHAR(date,'YYYY-MM') AS ym, store,
           walk_in_chinese, walk_in_malay, walk_in_indian, walk_in_other, walk_in_total, by_race
      FROM public.floatation
     WHERE date >= (p_ym || '-01')::date - INTERVAL '3 month'
       AND date <  (p_ym || '-01')::date + INTERVAL '1 month'
  ),
  long AS (
    SELECT f.ym, f.store, r.race,
           COALESCE(r.walkin,0) AS walkin, COALESCE(r.revenue,0) AS revenue, COALESCE(r.purchase,0) AS purchase
      FROM f CROSS JOIN LATERAL (VALUES
        ('chinese', f.walk_in_chinese, (f.by_race->'chinese'->>'amount')::numeric, (f.by_race->'chinese'->>'purchase')::numeric),
        ('malay',   f.walk_in_malay,   (f.by_race->'malay'->>'amount')::numeric,   (f.by_race->'malay'->>'purchase')::numeric),
        ('indian',  f.walk_in_indian,  (f.by_race->'indian'->>'amount')::numeric,  (f.by_race->'indian'->>'purchase')::numeric),
        ('other',   f.walk_in_other,   (f.by_race->'others'->>'amount')::numeric,  (f.by_race->'others'->>'purchase')::numeric)
      ) AS r(race, walkin, revenue, purchase)
  ),
  by_smr AS (
    SELECT store, race, ym, SUM(walkin) AS walkin, SUM(purchase) AS purchase, SUM(revenue) AS revenue
      FROM long GROUP BY store, race, ym
  ),
  cell AS (
    SELECT store, race,
      COALESCE(SUM(walkin)   FILTER (WHERE ym = p_ym),0) AS cur_walk,
      COALESCE(SUM(purchase) FILTER (WHERE ym = p_ym),0) AS cur_pur,
      COALESCE(SUM(revenue)  FILTER (WHERE ym = p_ym),0) AS cur_rev,
      SUM(walkin)   FILTER (WHERE ym = v_prev) AS prev_walk,
      SUM(purchase) FILTER (WHERE ym = v_prev) AS prev_pur,
      AVG(walkin)   FILTER (WHERE ym < p_ym)   AS avg_walk,
      SUM(purchase) FILTER (WHERE ym < p_ym)   AS prior_pur,
      SUM(walkin)   FILTER (WHERE ym < p_ym)   AS prior_walk
    FROM by_smr GROUP BY store, race
  ),
  cell2 AS (
    SELECT store, race, jsonb_build_object(
      'walkin',          cur_walk,
      'purchases',       cur_pur,
      'closing_rate',    CASE WHEN cur_walk>0 THEN ROUND(cur_pur/cur_walk*100,1) END,
      'revenue',         ROUND(cur_rev,2),
      'walkin_prev',     prev_walk,
      'walkin_3mo_avg',  ROUND(avg_walk,1),
      'closing_prev',    CASE WHEN prev_walk>0  THEN ROUND(prev_pur/prev_walk*100,1) END,
      'closing_3mo_avg', CASE WHEN prior_walk>0 THEN ROUND(prior_pur/prior_walk*100,1) END
    ) AS cobj FROM cell
  ),
  store_pivot AS (
    SELECT store, jsonb_object_agg(race, cobj) AS races_obj FROM cell2 GROUP BY store
  ),
  totals AS (
    SELECT store, COALESCE(SUM(walk_in_total),0)::INT AS w_total
      FROM f WHERE ym = p_ym GROUP BY store
  )
  SELECT jsonb_agg(
           (jsonb_build_object('store', sp.store, 'total_walkin', COALESCE(t.w_total,0)) || sp.races_obj)
           ORDER BY sp.store
         ) INTO v_matrix
    FROM store_pivot sp
    LEFT JOIN totals t ON t.store = sp.store;

  RETURN jsonb_build_object('month', p_ym, 'matrix', COALESCE(v_matrix, '[]'::jsonb));
END $$;

COMMIT;

-- Quick check:
--   SELECT public.customer_by_race('2026-04', NULL);
--   SELECT public.customer_store_race_matrix('2026-04');
