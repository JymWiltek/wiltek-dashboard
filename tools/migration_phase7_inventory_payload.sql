-- ════════════════════════════════════════════════════════════════════
-- Phase 7 — inventory_phase7_payload(p_ym, p_branch)
-- 一个 RPC 返回 Inventory Owner BI 页所需全部数据 (8 sections)。
-- Scope: 全 store NOT IN ('W10','W12','WEX') (关店)。
-- 主力 6 店 = W01/W02/W03/W05/W07/W11 (矩阵 + ABC base)。
-- 仓库 = WLO/WSR/WL1 (Section 4 专区)。 HQ = WCO。
-- 5 段分类 = V1 逻辑 (Discontinued / Dead / Misplaced / Slow / Active)。
-- 所有数字带 vs 上月 (snap_prev); 无对比 → null → 前端显 —。
-- action_plan 内嵌 (5 类异常)。
-- ════════════════════════════════════════════════════════════════════
-- TO APPLY: apply_migration。幂等 (CREATE OR REPLACE)。
-- 旧 RPC inventory_dashboard_payload 不动 (Today 页可能引用)。
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.inventory_phase7_payload(
  p_ym text DEFAULT NULL,
  p_branch text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  snap_latest date;
  snap_prev   date;
  ym_curr     text;
  ym_prev     text;
  is_synth    boolean;
  scope_warn  text;
  result      jsonb;
BEGIN
  -- 1. snapshot dates
  IF p_ym IS NOT NULL AND p_ym <> '' THEN
    SELECT max(snapshot_date) INTO snap_latest
    FROM public.inventory_snapshots WHERE to_char(snapshot_date,'YYYY-MM') = p_ym;
  ELSE
    SELECT max(snapshot_date) INTO snap_latest FROM public.inventory_snapshots;
  END IF;
  IF snap_latest IS NULL THEN RETURN jsonb_build_object('error','no snapshot'); END IF;

  SELECT max(snapshot_date) INTO snap_prev
  FROM public.inventory_snapshots WHERE snapshot_date < snap_latest;
  ym_curr := to_char(snap_latest,'YYYY-MM');
  ym_prev := to_char(COALESCE(snap_prev, snap_latest - interval '1 month'),'YYYY-MM');

  SELECT bool_or(is_synthetic) INTO is_synth
  FROM public.inventory_snapshots WHERE snapshot_date = snap_latest;

  -- scope warning: prev 没仓库快照但 latest 有 → vs 上月受 scope 影响
  IF snap_prev IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.inventory_snapshots
       WHERE snapshot_date = snap_prev AND store IN ('WLO','WSR','WL1')
    ) AND EXISTS (
      SELECT 1 FROM public.inventory_snapshots
       WHERE snapshot_date = snap_latest AND store IN ('WLO','WSR','WL1')
    ) THEN
    scope_warn := snap_latest::text || ' 含仓库快照但 ' || snap_prev::text || ' 没有, vs 上月对比受 scope 变化影响';
  ELSE
    scope_warn := NULL;
  END IF;

  WITH sales_90d AS (
    SELECT item_code, store, qty_90d::numeric AS qty_90d
    FROM public.v_sku_qty_by_item_branch_90d
    WHERE store NOT IN ('W10','W12','WEX')
  ),
  company_sold AS (
    SELECT item_code, SUM(qty_90d)::numeric AS qty_total FROM sales_90d GROUP BY item_code
  ),
  classify AS (
    SELECT i.snapshot_date, i.store, i.item_code, i.qty::numeric AS qty, i.amount::numeric AS amount, i.cost::numeric AS cost,
      COALESCE(it.main_group,'—') AS main_group,
      COALESCE(s90.qty_90d,0) AS own_sold,
      COALESCE(cs.qty_total,0) AS company_sold,
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
    WHERE i.snapshot_date IN (snap_latest, snap_prev)
      AND i.store NOT IN ('W10','W12','WEX')
      AND (p_branch IS NULL OR i.store = p_branch)
  ),
  health_curr AS (
    SELECT cls, COUNT(*)::int AS sku, ROUND(SUM(amount))::int AS amt
    FROM classify WHERE snapshot_date = snap_latest GROUP BY cls
  ),
  health_prev AS (
    SELECT cls, COUNT(*)::int AS sku, ROUND(SUM(amount))::int AS amt
    FROM classify WHERE snapshot_date = snap_prev GROUP BY cls
  ),
  main6 AS (
    SELECT store,
      SUM(CASE WHEN cls='Active'       THEN amount ELSE 0 END)::int AS active_rm,
      SUM(CASE WHEN cls='Slow'         THEN amount ELSE 0 END)::int AS slow_rm,
      SUM(CASE WHEN cls='Misplaced'    THEN amount ELSE 0 END)::int AS misplaced_rm,
      SUM(CASE WHEN cls='Dead'         THEN amount ELSE 0 END)::int AS dead_rm,
      SUM(CASE WHEN cls='Discontinued' THEN amount ELSE 0 END)::int AS disc_rm,
      SUM(amount)::int AS total_rm,
      ROUND(100.0 * SUM(CASE WHEN cls IN ('Dead','Discontinued') THEN amount ELSE 0 END)
            / NULLIF(SUM(amount),0), 1) AS dead_pct
    FROM classify
    WHERE snapshot_date = snap_latest AND store IN ('W01','W02','W03','W05','W07','W11')
    GROUP BY store
  ),
  warehouses_curr AS (
    SELECT store, COUNT(DISTINCT item_code)::int AS sku, SUM(qty)::int AS qty,
           SUM(amount)::int AS amount_rm, SUM(cost)::int AS cost_rm
    FROM public.inventory_snapshots
    WHERE snapshot_date = snap_latest AND store IN ('WLO','WSR','WL1')
    GROUP BY store
  ),
  warehouses_prev AS (
    SELECT store, SUM(amount)::int AS amount_rm, SUM(cost)::int AS cost_rm
    FROM public.inventory_snapshots
    WHERE snapshot_date = snap_prev AND store IN ('WLO','WSR','WL1')
    GROUP BY store
  ),
  abc_base AS (
    SELECT item_code, SUM(amount)::numeric AS amt_90d
    FROM public.sales
    WHERE sale_date >= snap_latest - interval '90 days'
      AND store IN ('W01','W02','W03','W05','W07','W11')
    GROUP BY item_code HAVING SUM(amount) > 0
  ),
  abc_ranked AS (
    SELECT item_code, amt_90d,
      SUM(amt_90d) OVER () AS grand,
      SUM(amt_90d) OVER (ORDER BY amt_90d DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum,
      ROW_NUMBER() OVER (ORDER BY amt_90d DESC) AS rnk
    FROM abc_base
  ),
  abc_classified AS (
    SELECT item_code, amt_90d, rnk,
      CASE WHEN cum/grand <= 0.80 THEN 'A' WHEN cum/grand <= 0.95 THEN 'B' ELSE 'C' END AS abcd
    FROM abc_ranked
  ),
  abc_summary AS (
    SELECT abcd, COUNT(*)::int AS sku, ROUND(SUM(amt_90d))::int AS sales_90d_rm,
      ROUND(100.0 * SUM(amt_90d) / SUM(SUM(amt_90d)) OVER (), 1) AS pct
    FROM abc_classified GROUP BY abcd
  ),
  a_items AS (SELECT item_code, rnk FROM abc_classified WHERE abcd='A'),
  a_no_stock AS (
    SELECT ai.item_code, ai.rnk
    FROM a_items ai
    LEFT JOIN (
      SELECT DISTINCT item_code FROM public.inventory_snapshots
      WHERE snapshot_date = snap_latest
        AND store IN ('W01','W02','W03','W05','W07','W11') AND qty > 0
    ) hs ON hs.item_code = ai.item_code
    WHERE hs.item_code IS NULL
  ),
  sku_dead AS (
    SELECT item_code, main_group, store, qty::int AS qty, ROUND(amount)::int AS amount,
           ROW_NUMBER() OVER (ORDER BY amount DESC) rn
    FROM classify WHERE snapshot_date = snap_latest AND cls='Dead'
  ),
  sku_slow AS (
    SELECT item_code, main_group, store, qty::int AS qty, ROUND(amount)::int AS amount,
           ROW_NUMBER() OVER (ORDER BY amount DESC) rn
    FROM classify WHERE snapshot_date = snap_latest AND cls='Slow'
  ),
  sku_disc AS (
    SELECT item_code, main_group, store, qty::int AS qty, ROUND(amount)::int AS amount,
           ROW_NUMBER() OVER (ORDER BY amount DESC) rn
    FROM classify WHERE snapshot_date = snap_latest AND cls='Discontinued'
  ),
  a_no_stock_detail AS (
    SELECT ans.item_code, ans.rnk, COALESCE(it.main_group,'—') AS main_group,
           ROUND(abc.amt_90d)::int AS sales_90d_rm
    FROM a_no_stock ans
    JOIN abc_classified abc ON abc.item_code = ans.item_code
    LEFT JOIN public.items it ON it.item_code = ans.item_code
  ),
  oem AS (
    SELECT
      COUNT(*) FILTER (WHERE p.grn_date IS NULL AND i.country='CHINA')::int AS open_lines,
      COALESCE(ROUND(SUM(p.po_amt) FILTER (WHERE p.grn_date IS NULL AND i.country='CHINA')),0)::int AS open_amt
    FROM public.po_grn p
    LEFT JOIN public.items i ON i.item_code = p.item_code
  ),
  cdp AS (
    SELECT ROUND(100.0 * SUM(CASE WHEN cls IN ('Dead','Discontinued') THEN amount ELSE 0 END)
                 / NULLIF(SUM(amount),0), 1) AS v
    FROM classify WHERE snapshot_date = snap_latest AND store IN ('W01','W02','W03','W05','W07','W11')
  ),
  mis AS (
    SELECT ROUND(100.0 * SUM(amount) FILTER (WHERE cls='Misplaced') / NULLIF(SUM(amount),0), 1) AS pct,
           COALESCE(SUM(amount) FILTER (WHERE cls='Misplaced'),0)::int AS rm,
           COALESCE(COUNT(*) FILTER (WHERE cls='Misplaced'),0)::int AS sku
    FROM classify WHERE snapshot_date = snap_latest
  ),
  actions AS (
    SELECT 1 AS ord, m.dead_pct AS sortk, jsonb_build_object(
      'id','matrix_dead_pct_high','severity','red',
      'title', m.store||' 死货占比 '||m.dead_pct||'% (公司均 '||(SELECT v FROM cdp)||'%)',
      'desc', m.store||' 总库存 RM '||to_char(m.total_rm,'FM999,999,999')||' 中 RM '||to_char(m.dead_rm+m.disc_rm,'FM999,999,999')||' 为 Dead+Discontinued. 远超公司平均.',
      'action','派 '||m.store||' 店长本周清仓 / 转店 / 折扣处理',
      'module','inventory','amount', m.dead_rm+m.disc_rm,'amount_unit','RM',
      'source_data', jsonb_build_object('store',m.store,'dead_pct',m.dead_pct,'company_avg',(SELECT v FROM cdp))
    ) AS obj
    FROM main6 m WHERE m.dead_pct > (SELECT v FROM cdp) + 30
    UNION ALL
    SELECT 2, NULL, jsonb_build_object(
      'id','a_no_stock','severity','red',
      'title','A 类 '||(SELECT COUNT(*) FROM a_no_stock)||' 个 SKU 全公司无库存',
      'desc','Top 80% 收入贡献 SKU 中, '||(SELECT COUNT(*) FROM a_no_stock)||' 个在主力 6 店全部 qty=0. 销售机会流失.',
      'action','派采购紧急下单 / 调拨','module','purchasing',
      'amount',(SELECT COUNT(*)::int FROM a_no_stock),'amount_unit','SKU')
    WHERE (SELECT COUNT(*) FROM a_no_stock) > 0
    UNION ALL
    SELECT 3, NULL, jsonb_build_object(
      'id','misplaced_high','severity','amber',
      'title','Misplaced RM '||to_char((SELECT rm FROM mis),'FM999,999,999')||' (公司 '||(SELECT pct FROM mis)||'%)',
      'desc','全公司有 '||(SELECT sku FROM mis)||' SKU 列为 Misplaced (本店无销但他店有). 库存分布偏离需求.',
      'action','派各店本周对调 / 大店调小店','module','inventory',
      'amount',(SELECT rm FROM mis),'amount_unit','RM')
    WHERE (SELECT pct FROM mis) > 30
    UNION ALL
    SELECT 4, NULL, jsonb_build_object(
      'id','wl1_damage','severity','amber',
      'title','WL1 坏货区累积 RM '||to_char(COALESCE((SELECT cost_rm FROM warehouses_curr WHERE store='WL1'),0),'FM999,999,999')||' (按成本)',
      'desc', COALESCE((SELECT sku FROM warehouses_curr WHERE store='WL1'),0)||' SKU / '||COALESCE((SELECT qty FROM warehouses_curr WHERE store='WL1'),0)||' 件位于坏货区, 占用资金 (按 cost). vs 上月待真快照.',
      'action','派 QC 调查损因 / 退厂或报损','module','purchasing',
      'amount',COALESCE((SELECT cost_rm FROM warehouses_curr WHERE store='WL1'),0),'amount_unit','RM')
    WHERE COALESCE((SELECT cost_rm FROM warehouses_curr WHERE store='WL1'),0) > 5000
    UNION ALL
    SELECT 5, NULL, jsonb_build_object(
      'id','china_open_po','severity','amber',
      'title','China OEM 在途 '||(SELECT open_lines FROM oem)||' 笔 PO, RM '||to_char((SELECT open_amt FROM oem),'FM999,999,999'),
      'desc','OEM lead time 硬编码 51 天. po_grn 历史不够算月对比.',
      'action','联工厂催 ETA / 评估部分改空运','module','purchasing',
      'amount',(SELECT open_lines FROM oem),'amount_unit','lines')
    WHERE COALESCE((SELECT open_lines FROM oem),0) > 20
  )
  SELECT jsonb_build_object(
    'snapshot_date', snap_latest::text,
    'snapshot_prev_date', snap_prev::text,
    'ym_curr', ym_curr,
    'ym_prev', ym_prev,
    'is_synthetic', is_synth,
    'scope_warning', scope_warn,
    'branch_scope', COALESCE(p_branch,'all'),

    'hero', (
      WITH ct AS (SELECT ROUND(SUM(amount))::int AS amt, COUNT(DISTINCT item_code)::int AS sku FROM classify WHERE snapshot_date=snap_latest),
           pt AS (SELECT ROUND(SUM(amount))::int AS amt FROM classify WHERE snapshot_date=snap_prev),
           cd AS (SELECT SUM(amt)::int AS amt, SUM(sku)::int AS sku FROM health_curr WHERE cls IN ('Dead','Discontinued')),
           pd AS (SELECT SUM(amt)::int AS amt FROM health_prev WHERE cls IN ('Dead','Discontinued')),
           csl AS (SELECT amt::int AS amt, sku::int AS sku FROM health_curr WHERE cls='Slow'),
           psl AS (SELECT amt::int AS amt FROM health_prev WHERE cls='Slow'),
           ca AS (SELECT amt::int AS amt, sku::int AS sku FROM health_curr WHERE cls='Active'),
           pa AS (SELECT amt::int AS amt FROM health_prev WHERE cls='Active')
      SELECT jsonb_build_object(
        'total_stock', jsonb_build_object(
          'amount',(SELECT amt FROM ct),'sku',(SELECT sku FROM ct),
          'mom_pct', CASE WHEN (SELECT amt FROM pt)>0 THEN ROUND(100.0*((SELECT amt FROM ct)-(SELECT amt FROM pt))::numeric/(SELECT amt FROM pt),1) ELSE NULL END,
          'mom_amount',(SELECT amt FROM ct)-COALESCE((SELECT amt FROM pt),0)),
        'dead_combined', jsonb_build_object(
          'amount',(SELECT amt FROM cd),'sku',(SELECT sku FROM cd),
          'pct_of_total', CASE WHEN (SELECT amt FROM ct)>0 THEN ROUND(100.0*(SELECT amt FROM cd)::numeric/(SELECT amt FROM ct),1) ELSE 0 END,
          'mom_pct', CASE WHEN (SELECT amt FROM pd)>0 THEN ROUND(100.0*((SELECT amt FROM cd)-(SELECT amt FROM pd))::numeric/(SELECT amt FROM pd),1) ELSE NULL END,
          'mom_amount',(SELECT amt FROM cd)-COALESCE((SELECT amt FROM pd),0)),
        'slow', jsonb_build_object(
          'amount',(SELECT amt FROM csl),'sku',(SELECT sku FROM csl),
          'pct_of_total', CASE WHEN (SELECT amt FROM ct)>0 THEN ROUND(100.0*(SELECT amt FROM csl)::numeric/(SELECT amt FROM ct),1) ELSE 0 END,
          'mom_pct', CASE WHEN (SELECT amt FROM psl)>0 THEN ROUND(100.0*((SELECT amt FROM csl)-(SELECT amt FROM psl))::numeric/(SELECT amt FROM psl),1) ELSE NULL END,
          'mom_amount',(SELECT amt FROM csl)-COALESCE((SELECT amt FROM psl),0)),
        'active', jsonb_build_object(
          'amount',(SELECT amt FROM ca),'sku',(SELECT sku FROM ca),
          'pct_of_total', CASE WHEN (SELECT amt FROM ct)>0 THEN ROUND(100.0*(SELECT amt FROM ca)::numeric/(SELECT amt FROM ct),1) ELSE 0 END,
          'mom_pct', CASE WHEN (SELECT amt FROM pa)>0 THEN ROUND(100.0*((SELECT amt FROM ca)-(SELECT amt FROM pa))::numeric/(SELECT amt FROM pa),1) ELSE NULL END,
          'mom_amount',(SELECT amt FROM ca)-COALESCE((SELECT amt FROM pa),0))
      )
    ),

    'health_5class', (
      SELECT jsonb_object_agg(c.cls, jsonb_build_object(
        'amount', COALESCE(cur.amt,0),
        'sku',    COALESCE(cur.sku,0),
        'pct',    CASE WHEN (SELECT SUM(amt) FROM health_curr)>0 THEN ROUND(100.0*COALESCE(cur.amt,0)/(SELECT SUM(amt) FROM health_curr),1) ELSE 0 END,
        'mom_pct', CASE WHEN COALESCE(prv.amt,0)>0 THEN ROUND(100.0*(COALESCE(cur.amt,0)-prv.amt)::numeric/prv.amt,1) ELSE NULL END,
        'mom_amount', COALESCE(cur.amt,0)-COALESCE(prv.amt,0)
      ))
      FROM (VALUES ('Active'),('Slow'),('Misplaced'),('Dead'),('Discontinued')) AS c(cls)
      LEFT JOIN health_curr cur ON cur.cls = c.cls
      LEFT JOIN health_prev prv ON prv.cls = c.cls
    ),

    'matrix_main6', (SELECT jsonb_agg(jsonb_build_object(
      'store',store,'Active',active_rm,'Slow',slow_rm,'Misplaced',misplaced_rm,
      'Dead',dead_rm,'Discontinued',disc_rm,'total',total_rm,'dead_pct',dead_pct
    ) ORDER BY dead_pct DESC) FROM main6),

    'matrix_company_dead_pct', (SELECT v FROM cdp),

    'warehouses', (
      SELECT jsonb_object_agg(wc.store, jsonb_build_object(
        'sku',wc.sku,'qty',wc.qty,'amount_rm',wc.amount_rm,'cost_rm',wc.cost_rm,
        'mom_amount', wc.amount_rm - COALESCE((SELECT amount_rm FROM warehouses_prev wp WHERE wp.store=wc.store),0),
        'mom_note', CASE WHEN NOT EXISTS (SELECT 1 FROM warehouses_prev wp WHERE wp.store=wc.store) THEN snap_prev::text||' 无此仓快照' ELSE NULL END
      )) FROM warehouses_curr wc
    ),

    'abc', jsonb_build_object(
      'A', (SELECT jsonb_build_object('sku',sku,'sales_90d_rm',sales_90d_rm,'pct',pct) FROM abc_summary WHERE abcd='A'),
      'B', (SELECT jsonb_build_object('sku',sku,'sales_90d_rm',sales_90d_rm,'pct',pct) FROM abc_summary WHERE abcd='B'),
      'C', (SELECT jsonb_build_object('sku',sku,'sales_90d_rm',sales_90d_rm,'pct',pct) FROM abc_summary WHERE abcd='C'),
      'a_no_stock_company', (SELECT COUNT(*)::int FROM a_no_stock)
    ),

    'sku_lists', jsonb_build_object(
      'dead_top50', COALESCE((SELECT jsonb_agg(jsonb_build_object('item_code',item_code,'main_group',main_group,'store',store,'qty',qty,'amount',amount) ORDER BY amount DESC) FROM sku_dead WHERE rn<=50),'[]'::jsonb),
      'slow_top50', COALESCE((SELECT jsonb_agg(jsonb_build_object('item_code',item_code,'main_group',main_group,'store',store,'qty',qty,'amount',amount) ORDER BY amount DESC) FROM sku_slow WHERE rn<=50),'[]'::jsonb),
      'discontinued_top50', COALESCE((SELECT jsonb_agg(jsonb_build_object('item_code',item_code,'main_group',main_group,'store',store,'qty',qty,'amount',amount) ORDER BY amount DESC) FROM sku_disc WHERE rn<=50),'[]'::jsonb),
      'a_no_stock', COALESCE((SELECT jsonb_agg(jsonb_build_object('item_code',item_code,'main_group',main_group,'sales_90d_rm',sales_90d_rm,'rank_in_a',rnk) ORDER BY rnk) FROM a_no_stock_detail),'[]'::jsonb)
    ),

    'oem_in_transit', jsonb_build_object(
      'open_po_lines', (SELECT open_lines FROM oem),
      'open_po_amt_rm', (SELECT open_amt FROM oem),
      'lead_days_hardcoded', 51,
      'trend_placeholder', 'po_grn 只 2026-04 一月数据, 多月 trend 等 sync'
    ),

    'action_plan', COALESCE((SELECT jsonb_agg(obj ORDER BY ord, sortk DESC NULLS LAST) FROM actions),'[]'::jsonb)
  ) INTO result;

  RETURN result;
END $$;

-- Quick check:
--   SELECT public.inventory_phase7_payload(NULL, NULL);
