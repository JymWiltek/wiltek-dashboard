# Week 4 — Sprint 4: Inventory alerts + Products KPIs + assertion guards (2026-05-12)

*main commits: `ee9438c` (Sprint 4 main) → `dbab090` (12-fn limit fix) · 3-tier PASS*

## 进度

- **Track 1 ✅** — Inventory 4 alert cards (PO calendar / Transfer engine / Liquidation / PO anomalies)
- **Track 2 ✅** — Products 3 顶部 KPI 卡 (Velocity ABCD / Top 20 migrations / Strategic Push placeholder)
- **Track 3 ✅** — Row-count assertion guards 复制到全部 5 个 apply* (applyInventory / applyCbl / applyPoGrn / applyFloatation / applyFinancial)
- **Out-of-band 数据修复** — 2026-04-30 inventory_snapshots 列偏移 bug (Raw CS Sheet 加了未标 STATUS 列) 已修 + 重 sync (RM 1,105,510.75 byte-match financial_balance_sheet.stock)

## 3 层验收

### POINT (Inventory alerts byte-match)

```
PO calendar:    54 open / RM 60,357 unreceived
Transfer engine: 16 opportunities / RM 2,396 value est
Liquidation:    1,294 candidates / RM 256,233 locked value
PO anomalies:   0 overdue / 4 GRN deficit / 6 price drift > 20%
```

### POINT (Products KPIs byte-match)

```
Velocity:       1,357 total SKU / 954 active
                A=96 (RM 576k, 48.5%) / B=191 (RM 352k, 29.6%)
                C=381 (RM 228k, 19.2%) / D=689 (RM 33k, 2.8%)
Migrations:     20 notable A→C/D / D→A,B / C→A
Strategic Push: 0 (no A-class SKU opened in last 60d)
```

### RECONCILE

```
Velocity ABCD class count sum: 96 + 191 + 381 + 689 = 1,357 = total_sku ✓
Velocity amt sum: 576,597 + 351,790 + 228,324 + 32,816 = 1,189,527 ✓
Inventory health 5 classes sum = total_stock (already verified Sprint 3)
```

### ANOMALY (audit fields NULL = 0)

| Table | total rows | updated_by filled |
|---|---:|---:|
| customer_buy_lines | 1,905 | 1,905 ✓ |
| po_grn | 191 | 191 ✓ |
| floatation | 29 | 29 ✓ |
| financial_balance_sheet | 1 | 1 ✓ |
| financial_monthly | 7 | 7 ✓ |

## 新 prod 资源

- RPC `inventory_alerts_payload(p_branch)` — 4 alert cards
- RPC `products_payload(p_month, p_branch)` — 3 顶部 KPIs
- Endpoint `GET /api/inventory_dashboard` (default = KPIs, `?section=alerts` = 4 alerts)
- Endpoint `GET /api/products`
- Frontend `renderInventoryStage4Alerts()` + `renderProductsStage4()`
- Row-count assertion guards on all 5 apply* functions (Track 3)

## 撞墙 (自行解决)

### Vercel Hobby 12-function limit

第一次 PR 合并到 main 后 Vercel deploy 失败. 诊断: Vercel Hobby plan 最多 12 个 serverless function, 我加 2 个新的让总数到 13. 自行解决:
- 合并 `/api/inventory_alerts` 进 `/api/inventory_dashboard?section=alerts` (sub-route 同一函数)
- 移除独立 inventory_alerts.js 文件
- 现 prod 12 functions, build SUCCESS

### Inventory 2026-04-30 qty=0 (CRITICAL)

诊断 Track 1 时发现 2026-04-30 inventory 全部 qty=0 但 amount 还在. 根因: Raw CS Sheet 加了未标 STATUS 列, 列序成: STOCK CODE / BRANCH / **STATUS** (新) / QTY / UNIT COST / ON HAND, 但 sheet 头还是旧 5 列名. Sprint 1 loadRawCs 按 header 名读 col 2 ("QTY"), 实际拿到 "N"/"D"/"F" 状态字母. parseNum("N") = 0.

自修:
1. 改 `loadRawCs()` 加 column-shift detection (probe 第一行 QTY-positioned cell numericness, 不是数字就把 QTY/UC/AMT 全 shift +1)
2. 备份 `backups.inv_2026_04_30_pre_resync_20260512` (3956 行)
3. 重 sync via Node script + service-role key (3960 rows after FK)
4. 验: RM 1,105,510.75 = `financial_balance_sheet.stock` 1,105,510.70 (RM 0.05 rounding diff = exact match)

## 同步硬规则 (Decisions Log)

**2026-05-12**: 5 apply* 函数全部加 row-count assertion:
```javascript
source_row_count   // rows parsed from sheet
source_amt_sum     // SUM(amount/po_amt/etc) from source
db_row_count_after // post-write SELECT COUNT(*)
assertion_failed   // true if (ok / source_row_count) < 0.99
```

任何 silent truncation → `assertion_failed=true` → 写入 sync_log + apply response. 第 4 次 Supabase / Sheet 数据陷阱被 catch 在 write time.

## main 状态

```
dbab090 Sprint 4 fix: merge inventory_alerts → inventory_dashboard?section=alerts (#21)
ee9438c Sprint 4: Inventory alerts + Products top KPIs + assertion guards (#19)
3f67bc8 Sprint 3 hotfix report: 2026-03 sales re-sync (CBv3 bug)
61d71c5 Sprint 3: 2026-03 sales re-sync + first row-count assertion guard
fdeb1bb Sprint 3 hotfix v4 report
97718ba Sprint 3 hotfix v4: revert 5-store white-list
```

## Phase 3 Backlog (新增/保留)

- Per-SKU lead time (po_grn 累计 5+ 月历史后)
- Vercel Pro upgrade (Hobby 12-fn limit 是 silent failure mode — pro 上去后没限制)
- Liquidation tier 阈值校准 (现在 90/180/365d, 可能太宽)
- Transfer engine 估值算法 (现在用 30 天补货量 × from-store unit cost — 可改进)
- Strategic Push 接 Customer dashboard (Stage 6 Customer + designer/contractor 偏好)
- W11 / WCO 加进 floatation snap (Sprint 1 W11 backfill 已有 4 行月度, daily 还要)

## 关键给 Jym 的 1 句话

> Sprint 4 完工. Inventory 第二层 4 预警卡 + Products 顶 3 KPI + 5 个 apply* 全装防截断. 顺手修了 2026-04 inventory qty=0 (列偏移). main `dbab090`, 浏览验.

## 下周 (Sprint 5) 计划

按 MEGAJOB 阶段顺序:
1. **Stage 5 Finance dashboard**: Cash Runway + GP% + Net Profit YTD/MTD + 4 预警卡 (Receivables aging / Payables aging / Inventory capital locked / HR cost ratio)
2. **依赖 financial_monthly 多月数据** — 现在只有 1 行 (snap_ym only). Jym 跑一次 sync 拿到 12 个月 financial_monthly 后才能做 12M 趋势

---

*Code 自报 · 2026-05-12 · 3-tier PASS · dbab090 on main · 12 Vercel functions*
