-- migration_phase6c_total_members.sql
-- PR-C: add TOTAL MEMBERS (loyalty members enrolled at store) to the
-- 6-Store × Ethnicity matrix. Members = customers rows with a real type,
-- EXCLUDING type='Walk-in' (non-loyalty) and NULL type.
-- Definition locked by Jym/chat-Claude at GATE-C (2026-06-21).
-- Expected live-store values @ verify: W01 1166 · W02 1336 · W03 517 · W05 337 · W07 744.
--
-- Only change vs the prior function: new `mem` CTE + LEFT JOIN + 'total_members'
-- field in each per-store object. Everything else is byte-identical.

CREATE OR REPLACE FUNCTION public.customer_store_race_matrix(p_ym text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
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
  ),
  mem AS (
    SELECT primary_store, COUNT(*)::INT AS n
      FROM public.customers
     WHERE type IS NOT NULL AND type <> 'Walk-in'
     GROUP BY primary_store
  )
  SELECT jsonb_agg(
           (jsonb_build_object('store', sp.store, 'total_walkin', COALESCE(t.w_total,0), 'total_members', COALESCE(m.n,0)) || sp.races_obj)
           ORDER BY sp.store
         ) INTO v_matrix
    FROM store_pivot sp
    LEFT JOIN totals t ON t.store = sp.store
    LEFT JOIN mem m ON m.primary_store = sp.store;

  RETURN jsonb_build_object('month', p_ym, 'matrix', COALESCE(v_matrix, '[]'::jsonb));
END $function$;
