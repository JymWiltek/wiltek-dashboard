-- ════════════════════════════════════════════════════════════════════
-- Phase 7b — inventory_judgement_card(p_ym)
-- Inventory 页顶部「经营判断卡」: 5 问 5 答 + 综合判断 (5 条红线触发数)。
-- 复用 Phase 7 的 5 段分类 / ABC 逻辑。所有数字 byte-match。
-- 注: CTE 不跨语句, 故 Q4 dead_sku/dead_rm + Q1 misplaced_rm 在第 1 条
-- 语句里算进变量 (不在最终 jsonb 引用 classify_curr CTE)。
-- prev 触发数 V1 hardcode 0 (synth + scope 变化, 等 5/31 真快照再加)。
-- ════════════════════════════════════════════════════════════════════
-- TO APPLY: apply_migration。幂等 (CREATE OR REPLACE)。
-- 同步: inventory_phase7_payload 的 sku_lists 加了 a_class_all (见 phase7 文件)。
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.inventory_judgement_card(p_ym text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  snap_latest date;
  snap_prev   date;
  result      jsonb;
  rl_company_dead_pct numeric;
  rl_misplaced_pct    numeric;
  v_misplaced_rm      int;
  v_dead_sku          int;
  v_dead_rm           int;
  rl_worst_store_pct  numeric;
  rl_worst_store      text;
  rl_a_no_stock       int;
  rl_wl1_cost         int;
  triggered_count     int := 0;
  prev_triggered_count int := 0;
  TH_DEAD_PCT      constant numeric := 30;
  TH_WORST_STORE   constant numeric := 50;
  TH_A_NO_STOCK    constant int     := 30;
  TH_WL1_COST      constant int     := 20000;
  TH_MISPLACED_PCT constant numeric := 35;
BEGIN
  IF p_ym IS NOT NULL AND p_ym <> '' THEN
    SELECT max(snapshot_date) INTO snap_latest
    FROM public.inventory_snapshots WHERE to_char(snapshot_date,'YYYY-MM') = p_ym;
  ELSE
    SELECT max(snapshot_date) INTO snap_latest FROM public.inventory_snapshots;
  END IF;
  IF snap_latest IS NULL THEN RETURN jsonb_build_object('error','no snapshot'); END IF;
  SELECT max(snapshot_date) INTO snap_prev
  FROM public.inventory_snapshots WHERE snapshot_date < snap_latest;

  -- ── 红线 1 + 5 + Q4 dead + Q1 misplaced RM (全公司 5 段) ──
  WITH sales_90d AS (
    SELECT item_code, store, qty_90d::numeric AS qty_90d
    FROM public.v_sku_qty_by_item_branch_90d WHERE store NOT IN ('W10','W12','WEX')
  ),
  company_sold AS (SELECT item_code, SUM(qty_90d)::numeric AS qty_total FROM sales_90d GROUP BY item_code),
  cc AS (
    SELECT i.item_code, i.amount::numeric AS amount,
      CASE
        WHEN COALESCE(it.item_status,'') LIKE 'D-%' THEN 'Discontinued'
        WHEN COALESCE(cs.qty_total,0) = 0 THEN 'Dead'
        WHEN COALESCE(s90.qty_90d,0) = 0 THEN 'Misplaced'
        WHEN i.qty >= COALESCE(s90.qty_90d,0) THEN 'Slow'
        ELSE 'Active'
      END AS cls
    FROM public.inventory_snapshots i
    LEFT JOIN public.items it ON it.item_code = i.item_code
    LEFT JOIN sales_90d s90 ON s90.item_code = i.item_code AND s90.store = i.store
    LEFT JOIN company_sold cs ON cs.item_code = i.item_code
    WHERE i.snapshot_date = snap_latest AND i.store NOT IN ('W10','W12','WEX')
  )
  SELECT
    ROUND(100.0 * SUM(amount) FILTER (WHERE cls IN ('Dead','Discontinued')) / NULLIF(SUM(amount),0), 1),
    ROUND(100.0 * SUM(amount) FILTER (WHERE cls = 'Misplaced') / NULLIF(SUM(amount),0), 1),
    COALESCE(SUM(amount) FILTER (WHERE cls = 'Misplaced'),0)::int,
    COUNT(*) FILTER (WHERE cls IN ('Dead','Discontinued'))::int,
    COALESCE(SUM(amount) FILTER (WHERE cls IN ('Dead','Discontinued')),0)::int
  INTO rl_company_dead_pct, rl_misplaced_pct, v_misplaced_rm, v_dead_sku, v_dead_rm
  FROM cc;

  -- ── 红线 2: 最差主力店 Dead% ──
  WITH sales_90d AS (
    SELECT item_code, store, qty_90d::numeric AS qty_90d
    FROM public.v_sku_qty_by_item_branch_90d WHERE store NOT IN ('W10','W12','WEX')
  ),
  company_sold AS (SELECT item_code, SUM(qty_90d)::numeric AS qty_total FROM sales_90d GROUP BY item_code),
  cc AS (
    SELECT i.store, i.amount::numeric AS amount,
      CASE
        WHEN COALESCE(it.item_status,'') LIKE 'D-%' THEN 'Discontinued'
        WHEN COALESCE(cs.qty_total,0) = 0 THEN 'Dead'
        WHEN COALESCE(s90.qty_90d,0) = 0 THEN 'Misplaced'
        WHEN i.qty >= COALESCE(s90.qty_90d,0) THEN 'Slow'
        ELSE 'Active'
      END AS cls
    FROM public.inventory_snapshots i
    LEFT JOIN public.items it ON it.item_code = i.item_code
    LEFT JOIN sales_90d s90 ON s90.item_code = i.item_code AND s90.store = i.store
    LEFT JOIN company_sold cs ON cs.item_code = i.item_code
    WHERE i.snapshot_date = snap_latest AND i.store IN ('W01','W02','W03','W05','W07','W11')
  )
  SELECT store, ROUND(dp,1) INTO rl_worst_store, rl_worst_store_pct FROM (
    SELECT store, 100.0 * SUM(amount) FILTER (WHERE cls IN ('Dead','Discontinued')) / NULLIF(SUM(amount),0) AS dp
    FROM cc GROUP BY store ORDER BY dp DESC NULLS LAST LIMIT 1
  ) z;

  -- ── 红线 3: A 类无库存数 ──
  WITH s90 AS (
    SELECT item_code, SUM(amount)::numeric AS amt_90d FROM public.sales
    WHERE sale_date >= snap_latest - interval '90 days'
      AND store IN ('W01','W02','W03','W05','W07','W11')
    GROUP BY item_code HAVING SUM(amount) > 0
  ),
  ranked AS (
    SELECT item_code, SUM(amt_90d) OVER () AS grand,
           SUM(amt_90d) OVER (ORDER BY amt_90d DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum
    FROM s90
  ),
  a_items AS (SELECT item_code FROM ranked WHERE cum/grand <= 0.80)
  SELECT COUNT(*)::int INTO rl_a_no_stock FROM a_items ai
  WHERE NOT EXISTS (
    SELECT 1 FROM public.inventory_snapshots
    WHERE snapshot_date = snap_latest AND store IN ('W01','W02','W03','W05','W07','W11')
      AND item_code = ai.item_code AND qty > 0);

  -- ── 红线 4: WL1 cost ──
  SELECT COALESCE(SUM(cost)::int,0) INTO rl_wl1_cost
  FROM public.inventory_snapshots WHERE snapshot_date = snap_latest AND store = 'WL1';

  triggered_count :=
    (CASE WHEN rl_company_dead_pct > TH_DEAD_PCT      THEN 1 ELSE 0 END) +
    (CASE WHEN rl_worst_store_pct  > TH_WORST_STORE   THEN 1 ELSE 0 END) +
    (CASE WHEN rl_a_no_stock       > TH_A_NO_STOCK    THEN 1 ELSE 0 END) +
    (CASE WHEN rl_wl1_cost         > TH_WL1_COST      THEN 1 ELSE 0 END) +
    (CASE WHEN rl_misplaced_pct    > TH_MISPLACED_PCT THEN 1 ELSE 0 END);
  prev_triggered_count := 0;  -- V1: synth + scope 变化, 不算 prev

  SELECT jsonb_build_object(
    'snapshot_date', snap_latest::text,
    'snapshot_prev_date', snap_prev::text,
    'is_synthetic', (SELECT bool_or(is_synthetic) FROM public.inventory_snapshots WHERE snapshot_date = snap_latest),
    'verdict', jsonb_build_object(
      'level', CASE WHEN triggered_count >= 3 THEN 'red' WHEN triggered_count >= 1 THEN 'amber' ELSE 'green' END,
      'label', CASE WHEN triggered_count >= 3 THEN '差' WHEN triggered_count >= 1 THEN '一般' ELSE '好' END,
      'red_lines_triggered', triggered_count,
      'red_lines_prev', prev_triggered_count,
      'direction', CASE WHEN prev_triggered_count = 0 THEN 'unknown'
                        WHEN triggered_count > prev_triggered_count THEN 'down'
                        WHEN triggered_count < prev_triggered_count THEN 'up' ELSE 'same' END,
      'direction_label', CASE WHEN prev_triggered_count = 0 THEN '—'
                              WHEN triggered_count > prev_triggered_count THEN '退步'
                              WHEN triggered_count < prev_triggered_count THEN '进步' ELSE '持平' END
    ),
    'red_lines', jsonb_build_object(
      'company_dead_pct',     jsonb_build_object('value',rl_company_dead_pct,'threshold',TH_DEAD_PCT,'triggered',rl_company_dead_pct > TH_DEAD_PCT),
      'worst_store_dead_pct', jsonb_build_object('value',rl_worst_store_pct,'threshold',TH_WORST_STORE,'triggered',rl_worst_store_pct > TH_WORST_STORE,'store',rl_worst_store),
      'a_no_stock_count',     jsonb_build_object('value',rl_a_no_stock,'threshold',TH_A_NO_STOCK,'triggered',rl_a_no_stock > TH_A_NO_STOCK),
      'wl1_cost_rm',          jsonb_build_object('value',rl_wl1_cost,'threshold',TH_WL1_COST,'triggered',rl_wl1_cost > TH_WL1_COST),
      'misplaced_pct',        jsonb_build_object('value',rl_misplaced_pct,'threshold',TH_MISPLACED_PCT,'triggered',rl_misplaced_pct > TH_MISPLACED_PCT)
    ),
    'q1_overstock', jsonb_build_object(
      'level', CASE WHEN rl_misplaced_pct + rl_company_dead_pct > 60 THEN 'red'
                    WHEN rl_misplaced_pct + rl_company_dead_pct > 40 THEN 'amber' ELSE 'green' END,
      'answer', CASE WHEN rl_misplaced_pct + rl_company_dead_pct > 60 THEN '是'
                     WHEN rl_misplaced_pct + rl_company_dead_pct > 40 THEN '一般' ELSE '否' END,
      'headline', 'Misplaced+Dead+Disc 占 ' || (rl_misplaced_pct + rl_company_dead_pct)::text || '%, RM ' || to_char(v_misplaced_rm + v_dead_rm, 'FM999,999,999') || ' 锁住',
      'detail', 'Misplaced 占大头, 不是真"多", 是"放错店"',
      'misplaced_rm', v_misplaced_rm  -- V2 Fix 件4: structured field so FE can compose bilingual headline
    ),
    'q2_understock', jsonb_build_object(
      'level', CASE WHEN rl_a_no_stock > TH_A_NO_STOCK THEN 'red' WHEN rl_a_no_stock > 10 THEN 'amber' ELSE 'green' END,
      'answer', CASE WHEN rl_a_no_stock > TH_A_NO_STOCK THEN '是' WHEN rl_a_no_stock > 10 THEN '一般' ELSE '否' END,
      'headline', 'A 类 (Top 80% 收入) ' || rl_a_no_stock::text || ' 个 SKU 全公司无库存',
      'drill_tab', 'a_no_stock', 'action_id', 'purchasing_a_class'
    ),
    'q3_what_to_order', jsonb_build_object(
      'headline', 'A 类无库存 ' || rl_a_no_stock::text || ' 个 (按 90d 销售排名, top 10)',
      'top10', COALESCE((
        WITH s90 AS (
          SELECT item_code, SUM(amount)::numeric AS amt_90d FROM public.sales
          WHERE sale_date >= snap_latest - interval '90 days'
            AND store IN ('W01','W02','W03','W05','W07','W11')
          GROUP BY item_code HAVING SUM(amount) > 0
        ),
        ranked AS (
          SELECT item_code, amt_90d, SUM(amt_90d) OVER () AS grand,
                 SUM(amt_90d) OVER (ORDER BY amt_90d DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum,
                 ROW_NUMBER() OVER (ORDER BY amt_90d DESC) AS rnk
          FROM s90
        ),
        a_ns AS (
          SELECT item_code, amt_90d, rnk FROM ranked r WHERE cum/grand <= 0.80
            AND NOT EXISTS (SELECT 1 FROM public.inventory_snapshots
              WHERE snapshot_date = snap_latest AND store IN ('W01','W02','W03','W05','W07','W11')
                AND item_code = r.item_code AND qty > 0)
          ORDER BY rnk LIMIT 10
        )
        SELECT jsonb_agg(jsonb_build_object('item_code',a_ns.item_code,'main_group',COALESCE(it.main_group,'—'),
          'sales_90d_rm',ROUND(a_ns.amt_90d)::int,'rank',a_ns.rnk) ORDER BY a_ns.rnk)
        FROM a_ns LEFT JOIN public.items it ON it.item_code = a_ns.item_code
      ),'[]'::jsonb),
      'drill_tab', 'a_no_stock'
    ),
    'q4_dead', jsonb_build_object(
      'level', CASE WHEN rl_company_dead_pct > TH_DEAD_PCT THEN 'red' WHEN rl_company_dead_pct > 20 THEN 'amber' ELSE 'green' END,
      'dead_sku', v_dead_sku, 'dead_rm', v_dead_rm,
      'detail', CASE WHEN rl_worst_store IS NOT NULL THEN '最严重: ' || rl_worst_store || ' Dead% ' || rl_worst_store_pct::text || '%' ELSE '' END,
      'worst_store', rl_worst_store, 'worst_store_pct', rl_worst_store_pct,  -- V2 Fix 件4: structured for FE bilingual q4 detail
      'drill_tab_primary', 'dead_top50', 'drill_tab_secondary', 'discontinued_top50', 'action_id', 'clear_dead_stock'
    ),
    'q5_core', jsonb_build_object(
      'level', CASE WHEN rl_a_no_stock > 30 THEN 'amber' ELSE 'green' END,
      'a_total_sku', (
        WITH s90 AS (
          SELECT item_code, SUM(amount)::numeric AS amt_90d FROM public.sales
          WHERE sale_date >= snap_latest - interval '90 days'
            AND store IN ('W01','W02','W03','W05','W07','W11')
          GROUP BY item_code HAVING SUM(amount) > 0
        ),
        ranked AS (SELECT item_code, SUM(amt_90d) OVER () AS grand,
                          SUM(amt_90d) OVER (ORDER BY amt_90d DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum
                   FROM s90)
        SELECT COUNT(*)::int FROM ranked WHERE cum/grand <= 0.80
      ),
      'a_no_stock', rl_a_no_stock,
      'detail', '卖完不补 = 直接漏单',
      'drill_tab', 'a_class_all'
    )
  ) INTO result;

  RETURN result;
END $$;

-- Quick check:
--   SELECT public.inventory_judgement_card('2026-04');
