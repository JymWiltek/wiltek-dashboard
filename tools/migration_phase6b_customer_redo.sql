-- ═══════════════════════════════════════════════════════════════════════
-- Wiltek Phase 6b — Customer page 根本性重做 (从 V1 搬照设计)
-- ─────────────────────────────────────────────────────────────────────
-- 背景: PR #55 的 Customer 页大半重复 Overview 且抹掉了 V1 的真功能。
-- 6b 把 V1 (Wiltek_MASTER.html) 的真实 Customer 设计搬进 V2:
--   会员年龄分段 / VIP 名单 / 沉睡 VIP / 老客流失 / 客型×龄段 cross-tab。
-- 这些数据已经全部在既有的 customers_payload(p_month, p_branch) RPC 里
-- (V1 在用,V2 共用同一个 Supabase),所以 6b 不需要新建核心 RPC ——
-- 只做两件后端改动:
--   1. 放宽 monthly_targets CHECK,新增 4 个 walkin_<race> target_type
--      (Jym 明确允许加 target_type)。
--   2. customer_by_race 增加「公司层走廊客 target」字段 (LEFT JOIN
--      monthly_targets 求和),让种族 4 cards 能显示目标 + 进度。
--      没设目标时返回 null → 前端显示「目标待设」,不造假数据。
-- ═══════════════════════════════════════════════════════════════════════
-- TO APPLY: apply_migration / Claude-chat。幂等 (CREATE OR REPLACE +
-- DROP IF EXISTS)。前端读到 walkin_target=null 时优雅降级。
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. 放宽 monthly_targets CHECK ──────────────────────────────────────
ALTER TABLE public.monthly_targets DROP CONSTRAINT IF EXISTS monthly_targets_type_chk;
ALTER TABLE public.monthly_targets ADD  CONSTRAINT monthly_targets_type_chk
  CHECK (target_type = ANY (ARRAY[
    'sales','footfall','closing_rate','basket_size',
    'walkin_chinese','walkin_malay','walkin_indian','walkin_other'
  ]));

-- ── 2. helper: one race row (加 p_target → walkin_target + 进度) ────────
-- 旧签名 6 参数;新增第 7 个 p_target,带 DEFAULT 保证向后兼容。
CREATE OR REPLACE FUNCTION public._cust_race_row(
  p_race TEXT, p_walk NUMERIC, p_pur NUMERIC, p_rev NUMERIC,
  p_tot_walk NUMERIC, p_tot_rev NUMERIC,
  p_target NUMERIC DEFAULT NULL
) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'race', p_race,
    'walkin', p_walk,
    'walkin_pct', CASE WHEN p_tot_walk>0 THEN ROUND(p_walk/p_tot_walk*100,1) ELSE NULL END,
    'purchases', p_pur,
    'closing_rate', CASE WHEN p_walk>0 THEN ROUND(p_pur/p_walk*100,1) ELSE NULL END,
    'revenue', ROUND(p_rev,2),
    'revenue_pct', CASE WHEN p_tot_rev>0 THEN ROUND(p_rev/p_tot_rev*100,1) ELSE NULL END,
    'avg_basket', CASE WHEN p_pur>0 THEN ROUND(p_rev/p_pur,2) ELSE NULL END,
    'walkin_target', p_target,
    'walkin_target_pct', CASE WHEN p_target>0 THEN ROUND(p_walk/p_target*100,1) ELSE NULL END);
$$;

-- ── 3. customer_by_race —— 加公司层走廊客 target ───────────────────────
-- p_store NULL = 全公司 (各店 walkin_<race> target 求和); 给定店 = 该店。
CREATE OR REPLACE FUNCTION public.customer_by_race(
  p_ym    TEXT,
  p_store TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_rows JSONB;
  v_tot_walk NUMERIC; v_tot_pur NUMERIC; v_tot_rev NUMERIC;
  v_t_ch NUMERIC; v_t_my NUMERIC; v_t_in NUMERIC; v_t_ot NUMERIC;
BEGIN
  WITH f AS (
    SELECT * FROM public.floatation
     WHERE TO_CHAR(date,'YYYY-MM') = p_ym
       AND (p_store IS NULL OR store = p_store)
  ),
  agg AS (
    SELECT
      COALESCE(SUM(walk_in_chinese),0) AS w_ch,
      COALESCE(SUM(walk_in_malay),0)   AS w_my,
      COALESCE(SUM(walk_in_indian),0)  AS w_in,
      COALESCE(SUM(walk_in_other),0)   AS w_ot,
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

  -- 走廊客 target: 求和 (NULLIF→0 当作未设 → 前端「目标待设」)
  SELECT
    NULLIF(COALESCE(SUM(target_value) FILTER (WHERE target_type='walkin_chinese'),0),0),
    NULLIF(COALESCE(SUM(target_value) FILTER (WHERE target_type='walkin_malay'),0),0),
    NULLIF(COALESCE(SUM(target_value) FILTER (WHERE target_type='walkin_indian'),0),0),
    NULLIF(COALESCE(SUM(target_value) FILTER (WHERE target_type='walkin_other'),0),0)
  INTO v_t_ch, v_t_my, v_t_in, v_t_ot
  FROM public.monthly_targets
  WHERE ym = p_ym AND (p_store IS NULL OR store = p_store);

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
    public._cust_race_row('chinese', a.w_ch, a.p_ch, a.r_ch, v_tot_walk, v_tot_rev, v_t_ch),
    public._cust_race_row('malay',   a.w_my, a.p_my, a.r_my, v_tot_walk, v_tot_rev, v_t_my),
    public._cust_race_row('indian',  a.w_in, a.p_in, a.r_in, v_tot_walk, v_tot_rev, v_t_in),
    public._cust_race_row('other',   a.w_ot, a.p_ot, a.r_ot, v_tot_walk, v_tot_rev, v_t_ot)
  ) INTO v_rows FROM agg a;

  RETURN jsonb_build_object(
    'month', p_ym,
    'races', v_rows,
    'total', jsonb_build_object(
      'walkin', v_tot_walk, 'purchases', v_tot_pur, 'revenue', ROUND(v_tot_rev,2),
      'closing_rate', CASE WHEN v_tot_walk>0 THEN ROUND(v_tot_pur/v_tot_walk*100,1) ELSE NULL END,
      'avg_basket',   CASE WHEN v_tot_pur>0 THEN ROUND(v_tot_rev/v_tot_pur,2) ELSE NULL END,
      'walkin_target', NULLIF(COALESCE(v_t_ch,0)+COALESCE(v_t_my,0)+COALESCE(v_t_in,0)+COALESCE(v_t_ot,0),0))
  );
END $$;

COMMIT;

-- Quick check:
--   SELECT public.customer_by_race('2026-04', NULL);
--   SELECT public.customers_payload('2026-04', NULL);  -- (既有, 不改)
