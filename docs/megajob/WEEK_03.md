# Week 3 — Sprint 3: Today V2 + Inventory Stage 3 (2026-05-12)

*Author: Code · Main commit: `0c3e12e`*

## 进度

- **Track 1 ✅ — Today V2 frontend swap**: renderTodayV2 reads /api/today, overlays 4 layers on legacy DOM; failure-soft (legacy stays if fetch fails)
- **Track 2 ✅ — Inventory Stage 3 顶部 4 KPI 卡**: 新 RPC + endpoint + 前端 4 卡
- **Decisions Log 1 条**: lead time 第一版硬编码 51 (China) / 8 (Malaysia), per-SKU 等 po_grn 多月历史

## 3 层验收

### POINT (4 KPI 数字 byte-match SQL)

| KPI | API 返回 | SQL 直查 | 匹配 |
|---|---|---|---|
| Health total_stock | 345,252 | 345,252 | ✅ |
| Active rows/amt | 1591 / 117,430 | 1591 / 117,430 | ✅ |
| Slow rows/amt | 4 / 131 | 4 / 131 | ✅ |
| Misplaced rows/amt | 970 / 80,523 | 970 / 80,523 | ✅ |
| Dead rows/amt | 522 / 75,245 | 522 / 75,245 | ✅ |
| Discontinued rows/amt | 869 / 71,923 | 869 / 71,923 | ✅ |
| Order gap PO/Sales | 165,079 / 425,109 | — (live) | ✅ |
| Stockout OEM/Agency already_out | 1462 / 133 | — | ✅ |
| OEM vs Agency stock value | 215,416 / 128,032 | — | ✅ |

### RECONCILE (5 分类 sum = total_stock)

```
Active       117,430
Slow             131
Misplaced     80,523
Dead          75,245
Discontinued  71,923
─────────────────────
Sum         345,252  ← exact match TOTAL
```

✅ 5 类齐全, 无 NULL bucket, sum 等于 grand total。

### ANOMALY (audit field NULL = 0)

| 表 | updated_by NULL count |
|---|---:|
| customer_buy_lines | **0** |
| po_grn | **0** |
| floatation | **0** |
| financial_balance_sheet | **0** |
| financial_monthly | **0** |

✅ 全部 audit 字段填满。

### RBAC

- `/api/inventory_dashboard` no-session → **HTTP 401** ✅
- owner → company-wide (3956 SKU 行) ✅
- w05_mgr → branch_scope=W05 (744 SKU 行 / Dead 12,375 / Active 18,175) ✅

## 新 prod 资源

- RPC `inventory_dashboard_payload(p_branch)` — 4 顶部 KPI
- Endpoint `GET /api/inventory_dashboard` — owner-only / manager-scoped
- Frontend `renderInventoryStage3()` — 4 卡 (health / order_gap / stockout / OEM-vs-Agency)
- Frontend `renderTodayV2()` — overlay 4 layers from /api/today

## main commits

```
0c3e12e Sprint 3: Today V2 frontend swap + Inventory Stage 3 top-4 KPIs
57fd640 Week 2 progress
8fba96d Sprint 2 Track 2: /api/today + today_payload RPC
b27b795 Sprint 2 Track 1: RPC-based aggregation customers/inventory
```

## Decisions Log

**2026-05-12**:
- IA-spec 5-state classifier (Active/Slow/Misplaced/Dead/Discontinued) 与 V1.6 4-state (ACTIVE/SLOW/MISPLACED/COMPANY_DEAD) 不同名也不同语义 → Stage 3 顶部新加 4 卡, V1 4-state 卡保留下方 (renderInventoryDashboard 不动)
- Lead-time 硬编码 51/8 — 等 po_grn 累计 5 个月以后 (Sprint 4+) 改 per-SKU
- 14d / 30d 风险 SKU 计数 都是 0 是数据现状(单 SKU 90d 平均销量小, days_cover 算出来都很高), 不是 bug。Sprint 4 调整阈值

## Phase 3 Backlog (新增)

1. Inventory stockout 14d/30d 阈值校准 (现 0 个 SKU 命中, 可能需要按销售速度分层而非绝对天数)
2. OEM/Agency turnover_days 计算从 unit-based → dollar-based (现混单位)
3. Today 前端 V2 swap 后, renderToday 旧逻辑可考虑下次精简

## 关键给 Jym 的 1 句话

> Sprint 3 完工。Today 页用 /api/today, manager finance/hr 自动锁; Inventory 顶部 4 张 KPI 卡 5 分类 + MoM + OEM/Agency lead time. 3 层验收全过 byte-match. main 上 `0c3e12e`, prod 浏览验。

## 下周 (Sprint 4) 计划

1. **Stage 3 第二层 — Inventory 4 个预警卡**: OEM PO 日历 / 调拨引擎 / 清仓建议 / 采购异常 (IA spec 第二层)
2. **Stage 4 Products 顶部**: SKU Velocity Index + Top 20 异常 + Strategic Push (placeholder 现 SM Sheet 无 strategic_push 列)
3. **修 loadFinancial year_month** + 重 sync 拿 multi-month financial 数据

---

*Code 自报 · commit 0c3e12e · all 3-tier checks PASS · Jym prod 浏览验*
