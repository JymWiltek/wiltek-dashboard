-- ════════════════════════════════════════════════════════════════════
-- Phase 8 — products_phase8_payload(p_ym, p_branch)
-- 一个 RPC 返回 Products Owner BI 页所需全部数据 (8 sections)。
-- Scope: sales NOT IN ('W10','W12','WEX')。月颗粒 (sale_date 当月)。
-- 价格段从 sales 真实成交单价反推 (items.prc_range 字段被业务混用, 不用)。
-- OEM = country CHINA, Agency = MALAYSIA。pro_preference 用 customer_buy_lines
-- (仅 2026-04 单月, 数据维度警告写明)。action_plan 内嵌 (5 类异常)。
-- ════════════════════════════════════════════════════════════════════
-- TO APPLY: apply_migration。幂等 (CREATE OR REPLACE)。
-- 旧 RPC products_payload 不动 (legacy /api/products 默认 path 引用)。
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.products_phase8_payload(
  p_ym text DEFAULT NULL,
  p_branch text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  ym_curr text;
  ym_prev text;
  date_curr_start date;
  date_curr_end   date;
  date_prev_start date;
  date_prev_end   date;
  result jsonb;
BEGIN
  IF p_ym IS NOT NULL AND p_ym <> '' THEN
    ym_curr := p_ym;
  ELSE
    SELECT to_char(MAX(sale_date), 'YYYY-MM') INTO ym_curr FROM public.sales;
  END IF;
  date_curr_start := (ym_curr || '-01')::date;
  date_curr_end   := (date_curr_start + interval '1 month')::date;
  date_prev_start := (date_curr_start - interval '1 month')::date;
  date_prev_end   := date_curr_start;
  ym_prev := to_char(date_prev_start, 'YYYY-MM');

  WITH
  sales_curr AS (
    SELECT s.item_code, s.qty, s.amount, i.main_group, i.brand, i.country
    FROM public.sales s
    LEFT JOIN public.items i ON i.item_code = s.item_code
    WHERE s.sale_date >= date_curr_start AND s.sale_date < date_curr_end
      AND s.store NOT IN ('W10','W12','WEX')
      AND (p_branch IS NULL OR s.store = p_branch)
  ),
  sales_prev AS (
    SELECT s.item_code, s.qty, s.amount, i.main_group, i.brand, i.country
    FROM public.sales s
    LEFT JOIN public.items i ON i.item_code = s.item_code
    WHERE s.sale_date >= date_prev_start AND s.sale_date < date_prev_end
      AND s.store NOT IN ('W10','W12','WEX')
      AND (p_branch IS NULL OR s.store = p_branch)
  ),
  hero_curr AS (SELECT SUM(amount)::int AS sales_total, COUNT(DISTINCT item_code)::int AS active_sku FROM sales_curr),
  hero_prev AS (SELECT SUM(amount)::int AS sales_total, COUNT(DISTINCT item_code)::int AS active_sku FROM sales_prev),
  total_sku_master AS (SELECT COUNT(*)::int AS n FROM public.items),
  top_mg AS (
    SELECT main_group, SUM(amount)::int AS rm FROM sales_curr WHERE main_group IS NOT NULL
    GROUP BY main_group ORDER BY rm DESC LIMIT 1
  ),
  px AS (
    SELECT item_code, SUM(amount)/NULLIF(SUM(qty),0) AS avg_price, SUM(amount) AS amt
    FROM sales_curr GROUP BY item_code HAVING SUM(qty) > 0
  ),
  px_prev AS (
    SELECT item_code, SUM(amount)/NULLIF(SUM(qty),0) AS avg_price, SUM(amount) AS amt
    FROM sales_prev GROUP BY item_code HAVING SUM(qty) > 0
  ),
  bands_curr AS (
    SELECT
      CASE WHEN avg_price<100 THEN '< RM 100' WHEN avg_price<300 THEN 'RM 100-300'
           WHEN avg_price<800 THEN 'RM 300-800' WHEN avg_price<2000 THEN 'RM 800-2k' ELSE 'RM 2k+' END AS band,
      CASE WHEN avg_price<100 THEN 1 WHEN avg_price<300 THEN 2 WHEN avg_price<800 THEN 3 WHEN avg_price<2000 THEN 4 ELSE 5 END AS band_order,
      COUNT(*) sku_count, SUM(amt)::int sales_rm
    FROM px GROUP BY 1,2
  ),
  bands_prev AS (
    SELECT
      CASE WHEN avg_price<100 THEN '< RM 100' WHEN avg_price<300 THEN 'RM 100-300'
           WHEN avg_price<800 THEN 'RM 300-800' WHEN avg_price<2000 THEN 'RM 800-2k' ELSE 'RM 2k+' END AS band,
      SUM(amt)::int sales_rm
    FROM px_prev GROUP BY 1
  ),
  bands_with_mom AS (
    SELECT b.band, b.band_order, b.sku_count, b.sales_rm,
      CASE WHEN bp.sales_rm>0 THEN ROUND(100.0*(b.sales_rm-bp.sales_rm)::numeric/bp.sales_rm,1) ELSE NULL END AS mom_pct,
      ROUND(100.0*b.sales_rm/SUM(b.sales_rm) OVER (),1) AS pct
    FROM bands_curr b LEFT JOIN bands_prev bp ON bp.band=b.band
  ),
  mg_curr AS (
    SELECT main_group, SUM(amount)::int rm, COUNT(DISTINCT item_code)::int sku_count
    FROM sales_curr WHERE main_group IS NOT NULL GROUP BY main_group
  ),
  mg_prev AS (SELECT main_group, SUM(amount)::int rm FROM sales_prev WHERE main_group IS NOT NULL GROUP BY main_group),
  mg_with_mom AS (
    SELECT m.main_group AS name, m.rm AS sales_rm, m.sku_count,
      ROUND(100.0*m.rm/SUM(m.rm) OVER (),1) AS pct,
      CASE WHEN mp.rm>0 THEN ROUND(100.0*(m.rm-mp.rm)::numeric/mp.rm,1) ELSE NULL END AS mom_pct
    FROM mg_curr m LEFT JOIN mg_prev mp ON mp.main_group=m.main_group
    ORDER BY m.rm DESC LIMIT 10
  ),
  source_curr AS (
    SELECT CASE WHEN country='CHINA' THEN 'oem_cn' WHEN country='MALAYSIA' THEN 'agency_my' ELSE 'other' END AS source,
      COUNT(DISTINCT item_code)::int sku_count, SUM(amount)::int sales_rm
    FROM sales_curr GROUP BY 1
  ),
  source_prev AS (
    SELECT CASE WHEN country='CHINA' THEN 'oem_cn' WHEN country='MALAYSIA' THEN 'agency_my' ELSE 'other' END AS source,
      SUM(amount)::int sales_rm
    FROM sales_prev GROUP BY 1
  ),
  source_with_mom AS (
    SELECT s.source, s.sku_count, s.sales_rm,
      ROUND(100.0*s.sales_rm/SUM(s.sales_rm) OVER (),1) AS pct,
      CASE WHEN sp.sales_rm>0 THEN ROUND(100.0*(s.sales_rm-sp.sales_rm)::numeric/sp.sales_rm,1) ELSE NULL END AS mom_pct
    FROM source_curr s LEFT JOIN source_prev sp ON sp.source=s.source
  ),
  top20 AS (
    SELECT s.item_code, MAX(i.main_group) main_group, MAX(i.brand) brand, MAX(i.country) country,
      SUM(s.qty)::int qty, SUM(s.amount)::int sales_rm,
      ROUND(SUM(s.amount)::numeric/NULLIF(SUM(s.qty),0),0)::int avg_price
    FROM public.sales s LEFT JOIN public.items i ON i.item_code=s.item_code
    WHERE s.sale_date >= date_curr_start AND s.sale_date < date_curr_end
      AND s.store NOT IN ('W10','W12','WEX') AND (p_branch IS NULL OR s.store=p_branch)
    GROUP BY s.item_code ORDER BY sales_rm DESC LIMIT 20
  ),
  pro_summary AS (
    SELECT cust_type,
      CASE cust_type WHEN 'C' THEN 'Contractor' WHEN 'D' THEN 'Designer' WHEN 'N' THEN 'Normal' WHEN '0' THEN 'Walk-in'
           ELSE COALESCE(cust_type,'Unknown') END AS cust_type_label,
      COUNT(*)::int lines, COUNT(DISTINCT item_code)::int sku_count,
      COUNT(DISTINCT member_code)::int customer_count, ROUND(SUM(amt))::int rm
    FROM public.customer_buy_lines
    WHERE year_month = ym_curr AND (p_branch IS NULL OR branch = p_branch)
    GROUP BY cust_type ORDER BY rm DESC
  ),
  contractor_top10 AS (
    SELECT item_code, MAX(main_group) main_group, COUNT(*)::int lines, ROUND(SUM(amt))::int amount
    FROM public.customer_buy_lines WHERE cust_type='C' AND year_month=ym_curr AND (p_branch IS NULL OR branch=p_branch)
    GROUP BY item_code ORDER BY amount DESC LIMIT 10
  ),
  designer_top10 AS (
    SELECT item_code, MAX(main_group) main_group, COUNT(*)::int lines, ROUND(SUM(amt))::int amount
    FROM public.customer_buy_lines WHERE cust_type='D' AND year_month=ym_curr AND (p_branch IS NULL OR branch=p_branch)
    GROUP BY item_code ORDER BY amount DESC LIMIT 10
  ),
  brand_curr AS (
    SELECT brand, MAX(country) country, COUNT(DISTINCT item_code)::int sku_count, SUM(amount)::int rm
    FROM sales_curr WHERE brand IS NOT NULL AND brand <> '' GROUP BY brand
  ),
  brand_prev AS (SELECT brand, SUM(amount)::int rm FROM sales_prev WHERE brand IS NOT NULL AND brand <> '' GROUP BY brand),
  brand_with_mom AS (
    -- pct = 占「总销售」(425k), 不是占品牌总和 — checklist「Wiltek 36% 销售」语义。
    -- (无品牌 sales 排除在 brand_curr 外, 故不能用 SUM() OVER() 当分母。)
    SELECT b.brand, b.country, b.sku_count, b.rm AS sales_rm,
      ROUND(100.0*b.rm/NULLIF((SELECT sales_total FROM hero_curr),0),1) AS pct,
      CASE WHEN bp.rm>0 THEN ROUND(100.0*(b.rm-bp.rm)::numeric/bp.rm,1) ELSE NULL END AS mom_pct
    FROM brand_curr b LEFT JOIN brand_prev bp ON bp.brand=b.brand
    ORDER BY b.rm DESC LIMIT 10
  )
  SELECT jsonb_build_object(
    'snapshot_month', ym_curr,
    'snapshot_prev_month', ym_prev,
    'branch_scope', COALESCE(p_branch,'all'),
    'data_notes', jsonb_build_object(
      'sales', '28 月历史',
      'customer_buy_lines', '仅 2026-04 单月, 多月历史等 sync',
      'prc_range_field', 'items.prc_range 字段被业务混用, 价格段从 sales 真实成交价反推'
    ),
    'hero', jsonb_build_object(
      'sales_total', jsonb_build_object(
        'amount_rm', (SELECT sales_total FROM hero_curr),
        'sku_count', (SELECT active_sku FROM hero_curr),
        'mom_pct', CASE WHEN (SELECT sales_total FROM hero_prev)>0
                        THEN ROUND(100.0*((SELECT sales_total FROM hero_curr)-(SELECT sales_total FROM hero_prev))::numeric/(SELECT sales_total FROM hero_prev),1) ELSE NULL END,
        'mom_amount', (SELECT sales_total FROM hero_curr)-COALESCE((SELECT sales_total FROM hero_prev),0)
      ),
      'sales_per_sku', jsonb_build_object(
        'amount_rm', CASE WHEN (SELECT active_sku FROM hero_curr)>0 THEN ROUND((SELECT sales_total FROM hero_curr)::numeric/(SELECT active_sku FROM hero_curr))::int ELSE 0 END,
        'mom_pct', NULL
      ),
      'active_sku', jsonb_build_object(
        'count', (SELECT active_sku FROM hero_curr),
        'total_sku', (SELECT n FROM total_sku_master),
        'pct', CASE WHEN (SELECT n FROM total_sku_master)>0 THEN ROUND(100.0*(SELECT active_sku FROM hero_curr)::numeric/(SELECT n FROM total_sku_master),1) ELSE 0 END,
        'mom_pct', CASE WHEN (SELECT active_sku FROM hero_prev)>0 THEN ROUND(100.0*((SELECT active_sku FROM hero_curr)-(SELECT active_sku FROM hero_prev))::numeric/(SELECT active_sku FROM hero_prev),1) ELSE NULL END
      ),
      'top_main_group', jsonb_build_object(
        'name', (SELECT main_group FROM top_mg),
        'amount_rm', (SELECT rm FROM top_mg),
        'pct', CASE WHEN (SELECT sales_total FROM hero_curr)>0 THEN ROUND(100.0*(SELECT rm FROM top_mg)::numeric/(SELECT sales_total FROM hero_curr),1) ELSE 0 END
      )
    ),
    'price_bands', (SELECT jsonb_agg(jsonb_build_object('band',band,'sku_count',sku_count,'sales_rm',sales_rm,'pct',pct,'mom_pct',mom_pct) ORDER BY band_order) FROM bands_with_mom),
    'top_main_groups', (SELECT jsonb_agg(jsonb_build_object('name',name,'sales_rm',sales_rm,'sku_count',sku_count,'pct',pct,'mom_pct',mom_pct)) FROM mg_with_mom),
    'source_split', (SELECT jsonb_object_agg(source, jsonb_build_object('sku_count',sku_count,'sales_rm',sales_rm,'pct',pct,'mom_pct',mom_pct)) FROM source_with_mom),
    'top20_sku', (SELECT jsonb_agg(jsonb_build_object('item_code',item_code,'main_group',main_group,'brand',brand,'country',country,'qty_30d',qty,'sales_30d_rm',sales_rm,'avg_price',avg_price) ORDER BY sales_rm DESC) FROM top20),
    'pro_preference', jsonb_build_object(
      'data_window', ym_curr || ' (1 month only — multi-month sync pending)',
      'by_cust_type', (SELECT jsonb_agg(jsonb_build_object('cust_type',cust_type,'cust_type_label',cust_type_label,'lines',lines,'sku_count',sku_count,'customer_count',customer_count,'rm',rm) ORDER BY rm DESC) FROM pro_summary),
      'contractor_top10', COALESCE((SELECT jsonb_agg(jsonb_build_object('item_code',item_code,'main_group',main_group,'lines',lines,'amount',amount) ORDER BY amount DESC) FROM contractor_top10),'[]'::jsonb),
      'designer_top10', COALESCE((SELECT jsonb_agg(jsonb_build_object('item_code',item_code,'main_group',main_group,'lines',lines,'amount',amount) ORDER BY amount DESC) FROM designer_top10),'[]'::jsonb)
    ),
    'top_brands', (SELECT jsonb_agg(jsonb_build_object('brand',brand,'country',country,'sku_count',sku_count,'sales_rm',sales_rm,'pct',pct,'mom_pct',mom_pct)) FROM brand_with_mom),
    'action_plan', (
      WITH active_sku_pct AS (
        SELECT ROUND(100.0*(SELECT active_sku FROM hero_curr)::numeric/NULLIF((SELECT n FROM total_sku_master),0),1) AS pct
      ),
      top_mg_conc AS (
        SELECT ROUND(100.0*(SELECT rm FROM top_mg)::numeric/NULLIF((SELECT sales_total FROM hero_curr),0),1) AS pct
      ),
      designer_cnt AS (SELECT customer_count, rm FROM pro_summary WHERE cust_type='D'),
      wiltek_share AS (SELECT pct, sales_rm FROM brand_with_mom WHERE brand='Wiltek'),
      cn_share AS (SELECT pct, sales_rm FROM source_with_mom WHERE source='oem_cn')
      SELECT jsonb_agg(act ORDER BY priority) FROM (
        SELECT 1 AS priority, jsonb_build_object(
          'id','low_active_sku_pct',
          'severity', CASE WHEN (SELECT pct FROM active_sku_pct)<15 THEN 'red' WHEN (SELECT pct FROM active_sku_pct)<25 THEN 'amber' ELSE 'green' END,
          'title','只 '||(SELECT pct FROM active_sku_pct)::text||'% SKU 在卖 ('||(SELECT active_sku FROM hero_curr)||'/'||(SELECT n FROM total_sku_master)||')',
          'desc','本月零销售 SKU 占大头, 跟 Inventory Dead/Disc 数据吻合',
          'action','派采购评估 SKU 库存合理性, 考虑停产清单','module','purchasing',
          'amount',(SELECT n FROM total_sku_master)-(SELECT active_sku FROM hero_curr),'amount_unit','SKU'
        ) AS act
        WHERE (SELECT pct FROM active_sku_pct) < 25
        UNION ALL
        SELECT 2, jsonb_build_object(
          'id','top_mg_too_concentrated',
          'severity', CASE WHEN (SELECT pct FROM top_mg_conc)>30 THEN 'amber' ELSE 'green' END,
          'title','品类集中度: '||(SELECT main_group FROM top_mg)||' 占 '||(SELECT pct FROM top_mg_conc)::text||'%',
          'desc','单品类占销售超 30% 为依赖风险','action','评估其他品类增长空间','module','sales',
          'amount',(SELECT pct FROM top_mg_conc)::int,'amount_unit','%'
        )
        WHERE (SELECT pct FROM top_mg_conc) > 30
        UNION ALL
        SELECT 3, jsonb_build_object(
          'id','designer_segment_thin','severity','amber',
          'title','Designer 客户只 '||COALESCE((SELECT customer_count FROM designer_cnt),0)::text||' 个, 本月 RM '||COALESCE((SELECT rm FROM designer_cnt),0)::text,
          'desc','高价值客群样本太薄, 数据维度只 1 月. 多月 sync 后再判断','action','派 Marketing 启动 Designer 关系建设','module','marketing',
          'amount',COALESCE((SELECT customer_count FROM designer_cnt),0),'amount_unit','designers'
        )
        WHERE COALESCE((SELECT customer_count FROM designer_cnt),0) < 20
        UNION ALL
        SELECT 4, jsonb_build_object(
          'id','wiltek_brand_dominant','severity','green',
          'title','Wiltek 自有品牌 '||COALESCE((SELECT pct FROM wiltek_share),0)::text||'% 销售',
          'desc','自牌占头部健康. OEM 总占比 '||COALESCE((SELECT pct FROM cn_share),0)::text||'% 由长尾贡献','action','继续推 Wiltek 品牌, 长尾 OEM 评估剪枝','module','purchasing',
          'amount',COALESCE((SELECT sales_rm FROM wiltek_share),0),'amount_unit','RM'
        )
        WHERE EXISTS (SELECT 1 FROM wiltek_share)
        UNION ALL
        SELECT 5, jsonb_build_object(
          'id','cn_oem_lead_risk',
          'severity', CASE WHEN (SELECT pct FROM cn_share)>70 THEN 'amber' ELSE 'green' END,
          'title','OEM (CN) 销售占 '||COALESCE((SELECT pct FROM cn_share),0)::text||'%',
          'desc','OEM lead time 长 (~51 天), 过度依赖供应风险高','action','评估 Agency 增加品类填补 lead time gap','module','purchasing',
          'amount',COALESCE((SELECT sales_rm FROM cn_share),0),'amount_unit','RM'
        )
        WHERE (SELECT pct FROM cn_share) > 70
      ) z
    )
  ) INTO result;

  RETURN result;
END $$;

-- Quick check:
--   SELECT public.products_phase8_payload('2026-04', NULL);
