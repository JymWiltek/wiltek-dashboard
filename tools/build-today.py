#!/usr/bin/env python3
# Wiltek Portal — V1 第 2 刀 today-overview data prep
# Reads:
#   /Users/jymchee/Desktop/Claude use/202604 CUSTOMER BUY.V3.xlsx
#   /Users/jymchee/Desktop/Claude use/202604 - SALES VS STOCK VS PO VS GRN.V2.xlsx
# Emits:
#   /Users/jymchee/wiltek-repo/assets/today-data.js
#
# Two slices:
#   churn          — high-lifetime members who haven't bought in 6+ months
#   po_exceptions  — closed POs with >30d delay + open POs >30d old
import json, os
from collections import defaultdict
from datetime import datetime
import openpyxl

CUST_XLSX = "/Users/jymchee/Desktop/Claude use/202604 CUSTOMER BUY.V3.xlsx"
SVS_XLSX  = "/Users/jymchee/Desktop/Claude use/202604 - SALES VS STOCK VS PO VS GRN.V2.xlsx"
OUT       = "/Users/jymchee/wiltek-repo/assets/today-data.js"

NOW_YM = (2026, 3)
NOW_DT = datetime(2026, 3, 31)

ACTIVE_BRANCHES = {"W01", "W02", "W03", "W05", "W07"}

def shift(ym, n):
    y, m = ym
    total = y * 12 + (m - 1) - n
    return (total // 12, total % 12 + 1)

def ym_str(ym):
    return f"{ym[0]:04d}-{ym[1]:02d}"

# ── Customer churn (D1) ──────────────────────────────────────────────
print("Reading customer xlsx …")
wb = openpyxl.load_workbook(CUST_XLSX, read_only=True, data_only=True)
ws = wb["Sheet27"]
mem = defaultdict(lambda: {
    "last": None, "first": None, "amt": 0.0,
    "visits": set(), "name": "", "branches": defaultdict(float), "loy": "",
})
for r in ws.iter_rows(min_row=2, values_only=True):
    if not r or r[0] is None: continue
    month, bill, code, br, name, mc, qty, amt, ct, enrol, loy, mg, sg = r
    if not mc: continue
    if not isinstance(month, datetime): continue
    d = mem[mc]
    if d["last"] is None or month > d["last"]: d["last"] = month
    if d["first"] is None or month < d["first"]: d["first"] = month
    d["amt"] += float(amt or 0)
    d["visits"].add(bill)
    if not d["name"]: d["name"] = name or ""
    if br: d["branches"][br] += float(amt or 0)
    if loy: d["loy"] = loy
wb.close()

# Churn cutoff: last purchase in or before 2025-09 (i.e. 6+ months ago vs 2026-03)
CHURN_CUTOFF = shift(NOW_YM, 5)
churned = []
for mc, d in mem.items():
    last_ym = (d["last"].year, d["last"].month)
    if last_ym >= CHURN_CUTOFF: continue
    if d["amt"] < 500: continue
    if len(d["visits"]) < 2: continue
    primary_branch = max(d["branches"].items(), key=lambda x: x[1])[0]
    months_ago = (NOW_YM[0] - last_ym[0]) * 12 + (NOW_YM[1] - last_ym[1])
    churned.append({
        "mc": mc,
        "name": d["name"][:40] if d["name"] else mc,
        "last": ym_str(last_ym),
        "months_ago": months_ago,
        "amount": round(d["amt"], 0),
        "visits": len(d["visits"]),
        "loyalty": d["loy"],
        "branch": primary_branch,
    })
churned.sort(key=lambda x: -x["amount"])
print(f"  Churned members: {len(churned)}  total lifetime RM {sum(c['amount'] for c in churned):,.0f}")

# Pull top-tier (high-value churn) for the card signal
TIER_HIGH_THRESHOLD = 1000
high_value_churn = [c for c in churned if c["amount"] >= TIER_HIGH_THRESHOLD]
total_high_value_lifetime = sum(c["amount"] for c in high_value_churn)
print(f"  High-value churned (RM ≥ {TIER_HIGH_THRESHOLD}): {len(high_value_churn)}  RM {total_high_value_lifetime:,.0f}")

# ── Procurement exceptions (C1) ──────────────────────────────────────
print("\nReading sales/stock/PO xlsx …")
wb = openpyxl.load_workbook(SVS_XLSX, read_only=True, data_only=True)
ws = wb["Raw Pivot"]
delayed = []   # closed PO, took >30 days
overdue = []   # open PO, no GRN, >30 days old
for r in ws.iter_rows(min_row=2, values_only=True):
    if not r or r[0] is None: continue
    pd, gd, code, br, pq, gq, pa, ga = r
    if not isinstance(pd, datetime): continue
    code = str(code).strip()
    pa = float(pa or 0)
    pq = float(pq or 0)
    if isinstance(gd, datetime):
        days = (gd - pd).days
        if days > 30:
            delayed.append({
                "code": code, "po_date": pd.strftime("%Y-%m-%d"),
                "grn_date": gd.strftime("%Y-%m-%d"),
                "days": days, "qty": pq, "amount": round(pa, 0),
                "kind": "delayed",
            })
    else:
        days = (NOW_DT - pd).days
        if days > 30:
            overdue.append({
                "code": code, "po_date": pd.strftime("%Y-%m-%d"),
                "grn_date": "", "days": days, "qty": pq, "amount": round(pa, 0),
                "kind": "overdue",
            })
wb.close()

# Pull SM brand metadata
print("Reading SM metadata for procurement …")
wb = openpyxl.load_workbook(SVS_XLSX, read_only=True, data_only=True)
ws = wb["SM"]
brand_map = {}
for r in ws.iter_rows(min_row=2, values_only=True):
    if not r or r[0] is None: continue
    code = str(r[0]).strip()
    brand = (r[10] or "") if isinstance(r[10], str) else ""
    sub = (r[5] or "") if isinstance(r[5], str) else ""
    mfr = (r[15] or "") if len(r) > 15 and isinstance(r[15], str) else ""
    brand_map[code] = {
        "brand": brand.strip(),
        "sub": sub.strip(),
        "manufacturer": mfr.strip(),
    }
wb.close()

for x in delayed:
    m = brand_map.get(x["code"], {})
    x["brand"] = m.get("brand", "")
    x["sub"] = m.get("sub", "")
    x["manufacturer"] = m.get("manufacturer", "")
for x in overdue:
    m = brand_map.get(x["code"], {})
    x["brand"] = m.get("brand", "")
    x["sub"] = m.get("sub", "")
    x["manufacturer"] = m.get("manufacturer", "")

delayed.sort(key=lambda x: -x["days"])
overdue.sort(key=lambda x: -x["days"])
print(f"  Delayed POs (>30d): {len(delayed)}  RM {sum(x['amount'] for x in delayed):,.0f}")
print(f"  Overdue open POs (>30d): {len(overdue)}  RM {sum(x['amount'] for x in overdue):,.0f}")

# ── Sales 3m by branch (for B1 sales-drop signal) ────────────────────
print("\nComputing branch sales trends …")
wb = openpyxl.load_workbook(SVS_XLSX, read_only=True, data_only=True)
ws = wb["Raw sale"]
branch_month_amt = defaultdict(lambda: defaultdict(float))
for r in ws.iter_rows(min_row=2, values_only=True):
    if not r or r[0] is None: continue
    month, code, br, qty, amt = r
    if not isinstance(month, datetime): continue
    if br not in ACTIVE_BRANCHES: continue
    ym = (month.year, month.month)
    branch_month_amt[br][ym] += float(amt or 0)
wb.close()

# Last 3 months sales per branch + previous 3 months
LAST_3 = [shift(NOW_YM, n) for n in range(0, 3)]
PREV_3 = [shift(NOW_YM, n) for n in range(3, 6)]
branch_sales_trend = {}
for br in ACTIVE_BRANCHES:
    last = sum(branch_month_amt[br].get(ym, 0) for ym in LAST_3)
    prev = sum(branch_month_amt[br].get(ym, 0) for ym in PREV_3)
    drop_pct = round((1 - last / prev) * 100, 1) if prev > 0 else 0
    branch_sales_trend[br] = {
        "last_3m": round(last, 0),
        "prev_3m": round(prev, 0),
        "drop_pct": drop_pct,
    }
print("  Branch sales trend:")
for br, t in branch_sales_trend.items():
    print(f"    {br}: last3 RM {t['last_3m']:>8,.0f}  prev3 RM {t['prev_3m']:>8,.0f}  drop {t['drop_pct']:+.1f}%")

# ── Output ───────────────────────────────────────────────────────────
payload = {
    "meta": {
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "snapshot": ym_str(NOW_YM),
    },
    "churn": {
        "summary": {
            "n_total": len(churned),
            "n_high_value": len(high_value_churn),
            "lifetime_rm": round(total_high_value_lifetime, 0),
            "cutoff_months": 6,
            "high_value_threshold": TIER_HIGH_THRESHOLD,
        },
        "rows": churned[:500],  # cap for ship size
    },
    "po_exceptions": {
        "summary": {
            "n_delayed": len(delayed),
            "n_overdue": len(overdue),
            "amount_delayed": round(sum(x["amount"] for x in delayed), 0),
            "amount_overdue": round(sum(x["amount"] for x in overdue), 0),
        },
        "delayed":  delayed[:300],
        "overdue":  overdue[:300],
    },
    "branch_sales_trend": branch_sales_trend,
}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    f.write("/* AUTO-GENERATED by tools/build-today.py — DO NOT EDIT BY HAND */\n")
    f.write(f"/* Snapshot: {ym_str(NOW_YM)} */\n")
    f.write("window.WP_TODAY = ")
    json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    f.write(";\n")

print(f"\nWrote {OUT}")
print(f"Size: {os.path.getsize(OUT):,} bytes")
