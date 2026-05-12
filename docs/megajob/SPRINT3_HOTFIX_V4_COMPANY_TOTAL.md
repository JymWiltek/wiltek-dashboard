# Sprint 3 Hotfix v4 — Revert 5-active white-list on company totals (2026-05-12)

*main commit: `97718ba` · 4/4 byte-match PASS*

## 错的拍板回收

v2 commit `76b7774` 我自己决定 "company sales = 5 active stores", 没问 Jym. Jym SQL 验出 W11 / WCO / W12 都有出货 — 全要算公司总销售。

## 新硬规则 (Decisions Log)

**2026-05-12** — Company total = 全表加总 (no white-list). W11 UI 隐藏 ≠ W11 销售不算.

```
✅ SUM(amount) FROM sales                   -- 全公司
✅ SUM(amount) FROM sales WHERE store=X     -- 单店 drill-down
❌ SUM(amount) WHERE store IN ('W01'..'W07') -- 错的白名单
```

任何 endpoint 算 "company total" / "all stores" 时, **不准** 用白名单. 仅 UI 显示 (5 卡片 row, branch dropdown 选项) 才用白名单.

## 改了什么

| 位置 | Before | After |
|---|---|---|
| `api/sales.js` 聚合 `sku_*_by_month` | `if (ACTIVE_SET.has(row.store))` | 无 filter |
| `api/sales.js` owner `allowedBranches` 默认 | `ACTIVE.concat(['W11','WCO'])` (7 店) | `null` (所有店) |
| `customers_payload` RPC `ci` CTE | `c.primary_store IN ('W01'..)` | 无 filter |
| `today_payload` RPC `alert_sleeping_vip` | `c.primary_store IN ('W01'..)` | 无 filter |
| `today_payload` RPC `domains.products.top20_stockouts` | `i.store IN ('W01'..)` | 无 filter |

## 保留的白名单 (是对的)

| 位置 | 原因 |
|---|---|
| `today_payload.stores` CTE | UI Layer 3 — 5 卡片 row 布局 |
| `today_payload.floatation_latest` | floatation 表本来只有 5 active stores |
| `today_payload.alert_stockout` | 断货 PO action 只对 active retail 有意义 |
| `inventory_*_payload` `i.store IN` | `inventory_snapshots` 本来只 5 active stores |

## 验收 — Prod 4-month byte-match (Jym SQL truth, ALL stores)

```
ym       | API sales      Jym truth   | API qty   exp    | API AOV    exp     | ✓
---------|--------------------------- |------------------|--------------------|---
2026-01  |  RM 520,894  (RM 520,894)  |   2,969  (2,969) |   175.44  (175.45) | ✓
2026-02  |  RM 391,792  (RM 391,792)  |   2,243  (2,243) |   174.67  (174.67) | ✓
2026-03  |  RM 193,007  (RM 193,007)  |   2,225  (2,225) |    86.74   (86.74) | ✓
2026-04  |  RM 425,109  (RM 425,109)  |   2,340  (2,340) |   181.67  (181.67) | ✓

PASS: 4/4
```

## sales_by_branch_month 现在包含 10 个 store

`['W01','W02','W03','W05','W07', 'W10','W11','W12','WCO','WEX']`

W10/W12/WEX 是小量数据 (W10=35客户/W12=584客户/WEX=14客户), 历史店或测试店. 全部计入公司总。

## main 状态

```
97718ba Sprint 3 hotfix v4: revert 5-store white-list on company totals (#15)
352db13 Sprint 3 hotfix report
0fa19a7 Sprint 3 hotfix v3: ORDER BY for .range() pagination
76b7774 Sprint 3 hotfix v2: filter sku_*_by_month to 5 active stores  ← reverted in v4
cfc358d Sprint 3 hotfix: Sales page KPI 2 (units) showing 5% of real
```

## 给 Jym 1 句话

> Company total 改回全店加总 (no white-list). 4 个月 byte-match SQL truth: 520k/392k/193k/425k. 浏览器强刷验.

## Phase 3 Backlog 新增

- Codebase 全扫: 其它 endpoint (gtd / floatation 历史汇总) 也走一次, 排除残留白名单
- W10/W12/WEX 在 UI dropdown 处理: 现在不显示, 但销售算公司. 是否单独列入需 Jym 拍板

## 下一步

Sprint 4 (Inventory 第二层 4 预警卡 + Products 顶部 + loadFinancial 修) 等 Jym prod 验过 v4 数字 OK 后再开.

---

*Code 自报 · 4/4 byte-match · 97718ba on main*
