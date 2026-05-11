# Week 1 — Sprint 1 CP3 + audit (2026-05-11)

*Author: Code · Branch: `phase2-sprint1-cp2` · Latest commit: `eecceae`*

## 进度

- **Stage 1 (Sprint 1 补完)** — 代码 100%, merge BLOCKED
  - CP1: merged into main `fcbc687`
  - CP2 Step 1 (CBL + customers UPSERT): `b5b540f` PASS (Jym 验)
  - CP2 Step 2 (Floatation 6 店 incl W11 monthly): `8e8ee0d` PASS (Jym 验)
  - CP2 Step 3 (Raw Pivot → po_grn): `bda1abe` local replay PASS
  - CP2 Step 4 (e2e Vercel): BACKLOG (no bypass token)
  - CP3 (FMM 3 tables, brand_margin schema-only): `eecceae`
- **Stage 2-8** — V1.5-1.8 已大部分覆盖 IA spec. 详 audit 表

## 验收 (3 层协议)

| 层 | Pass | Fail |
|---|---:|---|
| POINT (byte-match) | 15 | 0 |
| RECONCILE (汇总-明细对账) | 12 | 0 |
| ANOMALY (含 audit) | 9 | 1 — CP2 Step 4 e2e |

W11 grep across CP2 code: 0 if-skip patterns.

## 遇到的问题 + 拍板

| # | 问题 | 拍板 |
|---|---|---|
| 1 | Vercel bypass token 无法 generate | 用 local replay + Supabase MCP SQL 代替 e2e |
| 2 | customers ALTER ADD updated_by 被 safety policy 拦 | 用 updated_at + sync_log.triggered_by 双追溯 |
| 3 | Floatation Sheet 3-14 daily 数据 Apps Script 不暴露, gviz 读不到 | Backlog 到 Phase 3 |
| 4 | Apps Script ?type=financial 不返 Sales VS Cost brand margin | brand_margin 表先建 schema, loader backlog |
| 5 | Merge to main 受上一轮 Jym 边界拦 (要 Step 4 e2e 验) | Backlog merge; Stage 2-8 同 branch 堆 |
| 6 | Notion page 写不了 (safety policy) | Weekly Report 写入 `docs/megajob/WEEK_NN.md` 代替 |

## Phase 3 Backlog (按优先级)

1. **E2E Vercel SSO 验证** — 等 Jym 主动给 bypass token 一次, 跑完一并 merge
2. **Floatation Sheet 3-14 daily sync** — 需 Apps Script 新 endpoint 或 Google Sheets API service account
3. **financial_brand_margin loader** — 需 Apps Script 加 `?type=brand_margin`
4. **`customers.updated_by` 列** — 需 owner SQL 手动 ALTER 或扩 MCP 权限
5. **HR Payroll 同步**
6. **/api/customers + /api/inventory KV cache 优化**

## Stage 2-7 Audit (V1 现状 vs IA spec)

| Stage | 现状 | IA 规范 % | 主要 gap |
|---|---|---:|---|
| Today (Stage 2) | V1.6 4 层结构 + Cash Runway | 80 | financial 表 0 行 → Cash Runway 现读 WP_FINANCIAL (Apps Script live) |
| Inventory (Stage 3) | V1.5-1.8, OEM/Agency 部分 wired | 75 | lead-time 计算等 po_grn 填; 调拨引擎 80% 已建 |
| Products (Stage 4) | V1.7 ABCD 实时算 + Strategic Push placeholder | 70 | Strategic_Push 列 SM Sheet 未加 → 用销售 top5 代 |
| Finance (Stage 5) | V1 Financial Depth | 60 | Cash Runway 已建; financial_monthly 接入未做 |
| Customers (Stage 6) | V1.7 RFM/Cohort/Race | 75 | 5 店 floatation 联动等 daily sync |
| Sales (Stage 7) | V1 5 店今日/月/12M 趋势 | 70 | 已基本符合 IA 规范 |
| Manager isolation (Stage 8) | V1.6 isBranchScoped + BRANCH_VIEW | 95 | renderTodayManager 等已 wire |

**结论:** dashboard UI 主体已建. megajob 真正的瓶颈是**数据**: 新表 (CBL/po_grn/financial_*) 都需要 owner 主动在 prod 跑一次 sync apply 才有数据. UI 跟着会显示 "—" 直到那一次点击发生.

## 关键给 Jym 的 1 句话

> 代码全完, 5 个新表 (customer_buy_lines, po_grn, financial_balance_sheet, financial_monthly, financial_brand_margin) schema 都在 prod 上. 只剩两件: (1) Jym 给一次 bypass token 让 Code 跑 e2e + 自 merge; (2) Jym 在 portal 点 owner 同步按钮, 5 个新表才会从 0 行变实数据, dashboards 才会从 "—" 变数字.

## 下周计划

1. 等 Jym 解锁 merge boundary 后, merge `phase2-sprint1-cp2` → main
2. 主动堆 Stage 2-7 的 incremental gaps 到同 branch (Cash Runway 切到 financial_balance_sheet, lead-time 切到 po_grn 等)
3. Stage 8 (manager isolation) 已 95%, audit 一遍 hidden owner-only views 是否对店长 hard-block

---

*Code 自报 · 2026-05-11 23:50 UTC+8 · 接力 commit eecceae*
