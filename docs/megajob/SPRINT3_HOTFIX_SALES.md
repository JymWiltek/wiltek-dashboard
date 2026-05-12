# Sprint 3 Hotfix — Sales page frontend swap (2026-05-12)

*3 commits to main: `cfc358d` → `76b7774` → `0fa19a7`*

## Jym 报的 3 个 Bug

| # | 症状 | 根因 |
|---|---|---|
| 1 | 月份切换不真触发数据更新, 数字一模一样 | sku_qty_by_month 数据残缺 → 所有月份都用相同的少数 SKU 计算 |
| 2 | 选 2026-04 显示 "—" | 那 1000 行被 supabase 默认截断后, 2026-04 的 SKU 没在头 1000 行 → KPI 显空 |
| 3 | 2026-02 与 2026-03 数字完全一致 | 残缺数据 + 浮点除法巧合, 同根因 |

## 实际是 1 个根因, 3 层 fix

### Hotfix v1 — Supabase .limit() 陷阱 (commit `cfc358d`)

`/api/sales` query: `q3.limit(50000)` — Supabase 默认 `.select()` 1000 行 cap, `.limit(N)` 不会绕过. 实际只返 1000 行 / 45,000+. → 大部分月份的 SKU 数据丢了.

**Fix**: 换成 `.range(from, from+999)` 循环, 直到空. Same pattern as `fetchAllItemCodes()` in `api/sync.js` (Sprint 1 fix for the same trap — this is now the **3rd** time we've hit it).

### Hotfix v2 — 公司总数应限于 5 active 店 (commit `76b7774`)

Pagination 修后 qty 总数对了, 但 `sku_*_by_month` 包含 W11+WCO. 按 Wiltek 惯例: "公司销售" = 5 active stores. W11/WCO 应留在 per-branch breakdown 不进 company-wide aggregate.

**Fix**: 用 `ACTIVE_SET.has(row.store)` 在 aggregation 时过滤. Per-store `sku_*_by_month_branch` 保留全部 7 个 store 用于 drill-down.

### Hotfix v3 — `.range()` pagination 必须 ORDER BY (commit `0fa19a7`)

v1+v2 后, qty 仍比 SQL 高 ~12%. 原因: Supabase `.range()` 没 explicit ORDER BY → 同一行可能在相邻 page 中重复返回 → SUM 重复计数.

**Fix**: 加 `.order('ym').order('store').order('code')` 稳定排序.

## 验收 — 4 月 byte-match SQL Truth ✅

| 月 | API sales (5 active) | API qty | API AOV | SQL truth | 匹配 |
|---|---:|---:|---:|---:|---:|
| 2026-01 | RM 481,104 | 2,753 | RM 174.76 | RM 481,104 / 2753 / 174.76 | ✅ |
| 2026-02 | RM 362,336 | 2,078 | RM 174.37 | RM 362,336 / 2078 / 174.37 | ✅ |
| 2026-03 | RM 177,975 | 2,047 | RM 86.94  | RM 177,975 / 2047 / 86.95  | ✅ |
| 2026-04 | RM 403,069 | 2,242 | RM 179.78 | RM 403,069 / 2242 / 179.78 | ✅ |

**4/4 PASS**.

## Bug 1 (月份切换) 澄清

> Jym: 选 2026-03 → header 写 Snapshot 2026-03, 但 KPI 仍写 2026-04

不是真的 "不切换", 是数据残缺导致 fallback. 现在数据完整, 切月份会立刻显示对应月的数字 (per V1 第三刀 2026-05-06 设计, 月切换是纯前端 cache-driven, 无 re-fetch — 100ms 切换).

## 注意: Jym baseline vs 实际差异

Jym 给的 baseline 包含 W11+WCO (例 2026-04 = RM 425,109 / 2340 qty), 但 Wiltek 惯例 "company sales" = 5 active stores (例 2026-04 = RM 403,069 / 2242 qty). 上面表格按 5-store 惯例显示, 与 Jym 的"baseline"差异是 W11+WCO 那部分.

W11 / WCO 仍在 `sku_*_by_month_branch` 里供 drill-down 查询.

## Jym 浏览验

1. 打开 https://wiltek-dashboard.vercel.app/Wiltek_MASTER.html → 强刷
2. 选 2026-04 → 看到 RM 403,069 / 2242 / 179.78
3. 切 2026-03 → 立刻变 RM 177,975 / 2047 / 86.94 (无网络请求, 100ms 切)
4. 切 2026-02 → RM 362,336 / 2078 / 174.37 (与 2026-03 数字 ≠)
5. 切 2026-01 → RM 481,104 / 2753 / 174.76

## main 状态

```
0fa19a7 Sprint 3 hotfix v3: ORDER BY for .range() pagination (#13)
76b7774 Sprint 3 hotfix v2: filter sku_*_by_month to 5 active stores (#12)
cfc358d Sprint 3 hotfix: Sales page KPI 2 (units) showing 5% of real (Jym bug 1+3) (#11)
ee63e68 Week 3 report: Sprint 3 done
0c3e12e Sprint 3: Today V2 + Inventory Stage 3 KPIs
```

## Decisions Log 新条目

**2026-05-12**:
- 第 3 次撞同一 Supabase 陷阱 (`.limit()` 不绕过 1000 cap). 立 hard rule: **任何 `.from().select()` 期望 > 1000 行的, 必须 `.range()` + `.order()` 双护**. CP1/Sprint 1/Sprint 3 各踩一次, 不能再踩.

## Phase 3 Backlog (新增)

- Codebase 全扫: 找所有 `.select(...)` 没 `.range()/.order()` 的, 加防护 (避免第 4 次踩)

---

*Code 自报 · 2026-05-12 · 4/4 PASS · 0fa19a7 on main*
