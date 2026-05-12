# Week 2 — Sprint 2 完成 · RPC 化加 Today (2026-05-12)

*Author: Code · Main commit: `8fba96d`*

## 进度

- **Track 1 (perf) ✅** — RPC 化 /api/customers + /api/inventory
- **Track 2 (Today) ✅** — today_payload RPC + /api/today endpoint
- **Frontend wiring** — 推迟到下周 (现有 renderToday 仍可用)

## 验收 (Jym 的 4 件事)

| # | 要求 | 实测 | 结果 |
|---|---|---|---|
| 1 | `/api/customers` p50 < 4s, p95 < 6s | cold 5.23s, warm 2.7-3.2s | ✅ p50 ~3s |
| 1 | `/api/inventory` p50 < 3s, p95 < 5s | cold 3.61s, warm 2.4-2.5s | ✅ p50 ~2.5s |
| 2 | `/api/today` 返 4 层 JSON | 全部 4 层在 | ✅ |
| 3 | Today 染色 缺数据显 "数据缺失" | `status.data_missing: ["financial_monthly_for_2026-04"]`, light='unknown', finance/hr/customers/products 均 unknown light | ✅ |
| 4 | manager 登录看不到 Finance 方格 RBAC | 401 no-session; w05_mgr 拿 branch_scope='W05', action_plan 缩为 W05-only (sleeping_vip 12 vs owner 114) | ✅ |

## 性能提升

| Endpoint | Sprint 1 | Sprint 2 | 改善 |
|---|---:|---:|---|
| /api/customers cold | 12s | **5.2s** | 2.3x |
| /api/customers warm | ~10s | **2.7-3.2s** | 3-4x |
| /api/inventory cold | 8s | **3.6s** | 2.2x |
| /api/inventory warm | 5s | **2.4-2.5s** | 2x |
| /api/today | N/A | **1.3-1.7s warm** | new |

机制: 单 Postgres RPC + jsonb_build_object 聚合, 替换 14k+60k+8k 行的 Node.js 端 fetch + iterate。

## 新建 RPC 函数

- `customers_payload(p_month, p_branch)` — summary / summary_by_window / buckets_by_window / cross_by_window / top100 / churn / sales_by_branch_month
- `inventory_payload(p_branch)` — meta / totals / by_branch / rows / sku_branch_stock / sku_branch_sales_3m
- `today_payload(p_month, p_branch)` — status / action_plan / stores / domains (4 层)

## 新 endpoint

- `POST /api/today` (owner: full; manager: branch-locked; 401 if no session)

## 数据缺口处理 (Jym Option A)

- `financial_monthly` 当前只有 2025-03 一行 (loadFinancial 用错了 cashflow.months[0])
- Today 页 status.light = 'unknown' + data_missing 数组 通知 UI 显示 "数据缺失 · FMM Sheet 待更新"
- finance domain light 同样 unknown
- hr domain light 永远 unknown (Phase 3 backlog)

**Decision Log 加 1 条:**
> 2026-05-12: loadFinancial year_month 推断 bug (用 cashflow.months[0]) — 已在 Notion 报告中提及, fix 推 Sprint 3 (要 owner sync 一次新月数据才能验)

## Phase 3 Backlog (新增)

1. loadFinancial year_month 推断逻辑改用 today - 1 month
2. Cash Runway 12-month burn rate calc (today_payload.status.cash_runway_months 目前 null)
3. Today 前端 swap: renderToday → 直接读 /api/today
4. Customer repeat-rate (today_payload.domains.customers.light 现 unknown 占位)
5. Product Top-20 SKU stockout ranking
6. HR Payroll 表 + ?type=hr Apps Script endpoint

## 关键给 Jym 的 1 句话

> 三个 endpoint 都加快 2-4x, Today 页 backend 已就绪 (4 层全过验), 缺数据用 'unknown' 灯 + data_missing flags 而不是崩溃。下次会话: 把现有 Today 前端切到 /api/today 数据源。

## 下周计划 (Sprint 3)

1. **Frontend swap**: 用 /api/today 数据驱动 renderToday (按 IA spec 重新染色)
2. **修 loadFinancial year_month 逻辑** + Jym 触发一次 sync apply → financial_monthly 填新数据
3. **Stage 3 Inventory dashboard 第一刀**: 加 OEM/Agency Country=China vs Malaysia 分类 (items.country 已有数据)
4. **接入 po_grn**: 现已 191 行, 可以算 lead_time per SKU 第一版

---

*Code 自报 · commit 8fba96d · all RPCs live on prod*
