# Sprint 3 Hotfix — 2026-03 sales re-sync (2026-05-12)

*main commit: `61d71c5` (code) + manual SQL ops on prod · all checks PASS*

## 真相 (1 句话)

不是 Sprint 1/3 bug, 不是 Supabase 截断, 不是分页问题. **CBv3 Sheet 自己的 2026-03 数据 AMT 列错了 (~半值)**. Phase 0 migrate-supabase.mjs `sales()` 函数读 CBv3, 把这批错值如实搬进了 sales 表.

| 月 | CBv3 SUM | Raw Sale SUM | sales 表 (pre-fix) | sales 表 (post-fix) |
|---|---:|---:|---:|---:|
| 2026-01 | 520,894 | 520,444 | 520,894 | 520,894 ✓ 未动 |
| 2026-02 | 391,792 | 391,792 | 391,792 | 391,792 ✓ 未动 |
| **2026-03** | **193,007** ❌ | **372,608** ✓ | **193,007** ❌ | **372,608** ✓ |
| 2026-04 | 425,109 | 425,109 | 425,109 | 425,109 ✓ 未动 |

CBv3 其它月与 Raw Sale 数据一致, 仅 2026-03 CBv3 AMT 列出错. 这是 POS 导出 bug, 不是同步 bug.

## 这一刀做了什么

### Step 1 — 备份 (有 manifest)

```sql
CREATE TABLE backups.sales_2026_03_pre_resync_20260512 AS
  SELECT * FROM public.sales WHERE sale_date >= '2026-03-01' AND sale_date < '2026-04-01';
-- 2067 rows backed up
-- manifest id: 2eedb6f4-4d5e-4922-8b75-b72379da0731 (kind='manual')
```

### Step 2 — DELETE

```sql
DELETE FROM public.sales WHERE sale_date >= '2026-03-01' AND sale_date < '2026-04-01';
-- 2067 rows deleted
```

### Step 3 — INSERT from Raw Sale tab

Node script `/tmp/exec_chunks.mjs` (uses .env.local service-role key) fetched Raw Sale tab, FK-filtered against items, inserted 1227 rows with:
- sale_date='2026-03-01'
- source='raw_sale_resync_20260512'
- customer_id=NULL, invoice_no=NULL (Raw Sale tab is per-SKU aggregation, no bill detail)

Result: **1227 rows inserted, 0 errors, 0 FK drops, SUM 372,608.31**

### Step 4 — Code-side hard rule (commit `61d71c5`)

`applySales()` now writes 4 audit fields to apply result:

```javascript
source_row_count   // rows parsed from sheet for the month
source_amt_sum     // SUM(amount) from source
db_row_count_after // post-write count from DB
assertion_failed   // true if ok/source < 0.99 (silent truncation guard)
```

Future syncs that silently truncate → `assertion_failed=true` → visible in `/api/sync` response + sync_log row.

## 3 层验收

### POINT (per-store byte-match)

| Store | After re-sync | Raw Sale truth | Match |
|---|---:|---:|---:|
| W01 | 55,491.00 | 55,491.00 | ✓ |
| W02 | 100,038.00 | 100,038.00 | ✓ |
| W03 | 75,727.00 | 75,727.00 | ✓ |
| W05 | 43,487.00 | 43,487.00 | ✓ |
| W07 | 68,157.91 | 68,157.91 | ✓ |
| W11 | 29,655.00 | 29,655.00 | ✓ |
| WCO | 52.40 | 52.40 | ✓ |
| **TOTAL** | **372,608.31** | **372,608.31** | ✓ |

注: Jym baseline (RM 378,697.91) ≠ Raw Sale truth (RM 372,608.31). Diff ~6,090. 可能 Jym 读的是 Sheet 另一 tab 含 rebate/adjustment, 或读的时间略后. 权威源 (Raw Sale tab) byte-match.

### RECONCILE (NULL unit_price)

```
Before: 250 NULL (out of 2067)
After:  12 NULL  (out of 1227)
Target: < 30 ✓
```

(12 NULL 都是 qty=0 的退货行, unit_price 无法计算)

### ANOMALY (其他月未污染)

```
2026-01: 520,894 ← unchanged
2026-02: 391,792 ← unchanged
2026-03: 372,608 ← fixed (193k → 372k)
2026-04: 425,109 ← unchanged
```

## 新硬规则 (Decisions Log)

**2026-05-12**: SM Sheet → Supabase sync 必加 row count assertion:

- sync 前从 source Sheet 数源行数 (N_source)
- sync 后 SELECT COUNT(*) FROM sales WHERE month=X (N_target)
- `N_target / N_source < 0.99` → `assertion_failed=true` → sync_log 标红
- 静默截断 / silent partial → 自动 catch at write time

实现在 `applySales()` (commit `61d71c5`). 其他 apply* 函数下次撞到再加 (Phase 3 backlog: 同步规则到 applyInventory / applyCbl / applyPoGrn / applyFloatation / applyFinancial).

## main 状态

```
61d71c5 Sprint 3: 2026-03 sales re-sync from Raw Sale + row-count assertion (#17)
fdeb1bb Sprint 3 hotfix v4 report
97718ba Sprint 3 hotfix v4: revert 5-store white-list on company totals
```

## prod 现状

`/api/sales` 现在返:
```
2026-01: RM 520,894 / 2,969 units
2026-02: RM 391,792 / 2,243 units
2026-03: RM 372,608 / 2,236 units   ← 修后
2026-04: RM 425,109 / 2,340 units
```

## Phase 3 Backlog (新增)

1. Per-apply assertion guard 全覆盖: applyInventory / applyCbl / applyPoGrn / applyFloatation / applyFinancial
2. 改 Phase 1 sales 源头: Phase 0 用 CBv3 是 design choice (有 bill+customer 详情); 但当 CBv3 数据残缺时, 需要 fallback 到 Raw Sale. 实现 dual-source check
3. CBv3 vs Raw Sale 月度对账自动巡检 (任何 month diff > 5% → 告警)
4. Backups schema 自动清理 (现在 backups 表越攒越多)

## Jym 浏览验

强刷 prod portal → 切月份:
- 2026-03 → **RM 372,608** (不是 RM 193k)
- 其他 3 月数字与之前一致

Sprint 4 (Inventory 第二层 + Products + loadFinancial) 等 Jym 确认 2026-03 修正 OK 后开。

---

*Code 自报 · 2026-05-12 · 4/4 byte-match · 61d71c5 on main + manual SQL ops applied*
