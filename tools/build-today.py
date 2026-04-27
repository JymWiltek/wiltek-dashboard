#!/usr/bin/env python3
# Wiltek Portal — V1 第 2/2.1/3 刀 today + customer-insights data prep
# Reads:
#   /Users/jymchee/Desktop/Claude use/202604 CUSTOMER BUY.V3.xlsx
#   /Users/jymchee/Desktop/Claude use/202604 - SALES VS STOCK VS PO VS GRN.V2.xlsx
# Emits:
#   /Users/jymchee/wiltek-repo/assets/today-data.js      (today + churn + po_exceptions)
#   /Users/jymchee/wiltek-repo/assets/customers-data.js  (V1 第 3 刀 RFM + cross-table + top100)
import json, os
from collections import defaultdict, Counter
from datetime import datetime
import openpyxl

CUST_XLSX = "/Users/jymchee/Desktop/Claude use/202604 CUSTOMER BUY.V3.xlsx"
SVS_XLSX  = "/Users/jymchee/Desktop/Claude use/202604 - SALES VS STOCK VS PO VS GRN.V2.xlsx"
OUT_TODAY = "/Users/jymchee/wiltek-repo/assets/today-data.js"
OUT_CUST  = "/Users/jymchee/wiltek-repo/assets/customers-data.js"

NOW_YM = (2026, 3)
NOW_DT = datetime(2026, 3, 31)
LTM_CUTOFF = datetime(2025, 4, 1)   # last twelve months from snapshot

ACTIVE_BRANCHES = {"W01", "W02", "W03", "W05", "W07"}

# Cust-type code → display label (raw codes in xlsx are 1-letter)
CT_LABEL = {
    "N":   "Walk-in",
    "C":   "Contractor",
    "D":   "Interior Designer",
}
def ct_norm(raw):
    if raw is None: return "Other"
    s = str(raw).strip().upper()
    if s in CT_LABEL: return CT_LABEL[s]
    return "Other"

def shift(ym, n):
    y, m = ym
    total = y * 12 + (m - 1) - n
    return (total // 12, total % 12 + 1)

def ym_str(ym):
    return f"{ym[0]:04d}-{ym[1]:02d}"

# ── Customer master pass (collect everything we need across all 3 cuts) ──
print("Reading customer xlsx (single pass) …")
wb = openpyxl.load_workbook(CUST_XLSX, read_only=True, data_only=True)
ws = wb["Sheet27"]
mem = defaultdict(lambda: {
    "last": None, "first": None, "amt": 0.0,
    "visits": set(), "name": "", "branches": defaultdict(float), "loy": "",
    "enrol": None, "cust_type": "",
    "ltm_amt": 0.0, "ltm_visits": set(),
})
for r in ws.iter_rows(min_row=2, values_only=True):
    if not r or r[0] is None: continue
    month, bill, code, br, name, mc, qty, amt, ct, enrol, loy, mg, sg = r
    if not mc: continue
    if not isinstance(month, datetime): continue
    d = mem[mc]
    if d["last"] is None or month > d["last"]: d["last"] = month
    if d["first"] is None or month < d["first"]: d["first"] = month
    amt_f = float(amt or 0)
    d["amt"] += amt_f
    d["visits"].add(bill)
    if not d["name"]: d["name"] = name or ""
    if br: d["branches"][br] += amt_f
    if loy: d["loy"] = loy
    # Date Enrol — keep earliest non-null sane value
    if isinstance(enrol, datetime) and (d["enrol"] is None or enrol < d["enrol"]):
        # filter out garbage like 2099 placeholders
        if 1990 <= enrol.year <= 2026:
            d["enrol"] = enrol
    if ct and not d["cust_type"]: d["cust_type"] = ct_norm(ct)
    # LTM (last 12 months from snapshot)
    if month >= LTM_CUTOFF:
        d["ltm_amt"] += amt_f
        d["ltm_visits"].add(bill)
wb.close()
print(f"  Total members: {len(mem):,}")

# ── Customer churn (D1) ──────────────────────────────────────────────
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
        "mc": str(mc),
        "name": (d["name"][:40] if d["name"] else str(mc)),
        "last": ym_str(last_ym),
        "months_ago": months_ago,
        "amount": round(d["amt"], 0),
        "visits": len(d["visits"]),
        "loyalty": d["loy"],
        "branch": primary_branch,
        "cust_type": d["cust_type"] or "Other",
    })
churned.sort(key=lambda x: -x["amount"])
TIER_HIGH_THRESHOLD = 1000
high_value_churn = [c for c in churned if c["amount"] >= TIER_HIGH_THRESHOLD]
total_high_value_lifetime = sum(c["amount"] for c in high_value_churn)
print(f"  Churned: {len(churned)}  high-value: {len(high_value_churn)}  RM {total_high_value_lifetime:,.0f}")

# ── Customer Insights (V1 第 3 刀): RFM by Date Enrol ────────────────
# Tier the member by membership-age bucket at snapshot; only count members
# with at least one purchase at any time, primary branch in active 5.
def age_bucket(years):
    if years < 1:  return "<1y"
    if years < 5:  return "1-5y"
    if years < 8:  return "5-8y"
    return "8y+"

# Members with valid enrol + active branch + any purchase
ci_rows = []
for mc, d in mem.items():
    if d["last"] is None: continue
    if not d["branches"]: continue
    primary_branch = max(d["branches"].items(), key=lambda x: x[1])[0]
    if primary_branch not in ACTIVE_BRANCHES: continue
    if d["enrol"] is None: continue
    years = (NOW_DT - d["enrol"]).days / 365.25
    if years < 0: continue
    bucket = age_bucket(years)
    ci_rows.append({
        "mc": str(mc),
        "name": (d["name"][:40] if d["name"] else str(mc)),
        "branch": primary_branch,
        "cust_type": d["cust_type"] or "Other",
        "enrol": d["enrol"].strftime("%Y-%m-%d"),
        "age_years": round(years, 1),
        "age_bucket": bucket,
        "ltm_amt": round(d["ltm_amt"], 0),
        "ltm_visits": len(d["ltm_visits"]),
        "lifetime_amt": round(d["amt"], 0),
        "last": d["last"].strftime("%Y-%m"),
    })
print(f"  CI members (enrol+active+purchased): {len(ci_rows):,}")

BUCKETS = ["<1y", "1-5y", "5-8y", "8y+"]
TYPES   = ["Walk-in", "Contractor", "Interior Designer", "Other"]

# Per-bucket aggregate
bucket_agg = {b: {"n": 0, "ltm_amt": 0.0, "ltm_visits": 0, "n_repeat": 0} for b in BUCKETS}
for r in ci_rows:
    b = bucket_agg[r["age_bucket"]]
    b["n"] += 1
    b["ltm_amt"] += r["ltm_amt"]
    b["ltm_visits"] += r["ltm_visits"]
    if r["ltm_visits"] >= 2: b["n_repeat"] += 1
for b, v in bucket_agg.items():
    n_with_ltm = sum(1 for r in ci_rows if r["age_bucket"] == b and r["ltm_visits"] >= 1)
    v["aov"] = round(v["ltm_amt"] / v["ltm_visits"], 0) if v["ltm_visits"] else 0
    v["repeat_pct"] = round(100 * v["n_repeat"] / n_with_ltm, 1) if n_with_ltm else 0
    v["ltm_amt"] = round(v["ltm_amt"], 0)

# Cross-table type × bucket
cross = {tp: {b: {"n": 0, "ltm_amt": 0.0} for b in BUCKETS} for tp in TYPES}
for r in ci_rows:
    cell = cross[r["cust_type"] if r["cust_type"] in TYPES else "Other"][r["age_bucket"]]
    cell["n"] += 1
    cell["ltm_amt"] += r["ltm_amt"]
for tp in TYPES:
    for b in BUCKETS:
        cross[tp][b]["ltm_amt"] = round(cross[tp][b]["ltm_amt"], 0)

# Top 100 by LTM amt
ci_rows_top = sorted(ci_rows, key=lambda x: -x["ltm_amt"])[:100]

# Headline numbers
total_n = len(ci_rows)
n_5plus = sum(1 for r in ci_rows if r["age_bucket"] in ("5-8y", "8y+"))
ltm_total = sum(r["ltm_amt"] for r in ci_rows)
ltm_5plus = sum(r["ltm_amt"] for r in ci_rows if r["age_bucket"] in ("5-8y", "8y+"))
ci_summary = {
    "total_members": total_n,
    "n_lt1": bucket_agg["<1y"]["n"],
    "n_1_5": bucket_agg["1-5y"]["n"],
    "n_5_8": bucket_agg["5-8y"]["n"],
    "n_8plus": bucket_agg["8y+"]["n"],
    "ltm_total": round(ltm_total, 0),
    "ltm_lt1": bucket_agg["<1y"]["ltm_amt"],
    "ltm_1_5": bucket_agg["1-5y"]["ltm_amt"],
    "ltm_5_8": bucket_agg["5-8y"]["ltm_amt"],
    "ltm_8plus": bucket_agg["8y+"]["ltm_amt"],
    "pct_5plus_n": round(100 * n_5plus / total_n, 1) if total_n else 0,
    "pct_5plus_ltm": round(100 * ltm_5plus / ltm_total, 1) if ltm_total else 0,
    "snapshot": ym_str(NOW_YM),
}
print(f"  CI: 5y+ members {n_5plus:,} ({ci_summary['pct_5plus_n']}%) "
      f"contributed {ci_summary['pct_5plus_ltm']}% of LTM sales")

# ── Procurement exceptions (C1) ──────────────────────────────────────
print("\nReading sales/stock/PO xlsx …")
wb = openpyxl.load_workbook(SVS_XLSX, read_only=True, data_only=True)
ws = wb["Raw Pivot"]
delayed = []   # closed PO, took >30 days
overdue = []   # open PO, no GRN, >30 days old
overdue_noise = 0
for r in ws.iter_rows(min_row=2, values_only=True):
    if not r or r[0] is None: continue
    pd, gd, code, br, pq, gq, pa, ga = r
    if not isinstance(pd, datetime): continue
    code = str(code).strip()
    pa = float(pa or 0)   # PO amount (committed)
    ga = float(ga or 0)   # GRN amount (received)
    pq = float(pq or 0)
    gq = float(gq or 0)
    if isinstance(gd, datetime):
        days = (gd - pd).days
        if days > 30:
            # closed PO — use GRN AMT (what actually arrived & was paid for)
            delayed.append({
                "code": code, "po_date": pd.strftime("%Y-%m-%d"),
                "grn_date": gd.strftime("%Y-%m-%d"),
                "days": days, "qty": gq, "amount": round(ga, 0),
                "kind": "delayed",
            })
    else:
        days = (NOW_DT - pd).days
        if days > 30:
            # open PO — use PO AMT (committed but not yet received)
            # filter noise: zero qty AND zero amt = cancelled stub, not real overdue
            if pq <= 0 and pa <= 0:
                overdue_noise += 1
                continue
            overdue.append({
                "code": code, "po_date": pd.strftime("%Y-%m-%d"),
                "grn_date": "", "days": days, "qty": pq, "amount": round(pa, 0),
                "kind": "overdue",
            })
wb.close()
print(f"  Overdue noise filtered (qty=0 & amt=0): {overdue_noise}")

# Pull SM brand metadata
print("Reading SM metadata …")
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

for x in delayed + overdue:
    m = brand_map.get(x["code"], {})
    x["brand"] = m.get("brand", "")
    x["sub"] = m.get("sub", "")
    x["manufacturer"] = m.get("manufacturer", "")

# Sort: real overdue/delayed by amount desc (Jym wants to see real money first)
overdue.sort(key=lambda x: (-x["amount"], -x["days"]))
delayed.sort(key=lambda x: (-x["amount"], -x["days"]))
print(f"  Delayed POs (>30d, GRN AMT): {len(delayed)}  RM {sum(x['amount'] for x in delayed):,.0f}")
print(f"  Overdue open POs (>30d, PO AMT, noise-filtered): {len(overdue)}  RM {sum(x['amount'] for x in overdue):,.0f}")

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

# ── Output: today-data.js ────────────────────────────────────────────
payload_today = {
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
        "rows": churned[:500],
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

os.makedirs(os.path.dirname(OUT_TODAY), exist_ok=True)
with open(OUT_TODAY, "w", encoding="utf-8") as f:
    f.write("/* AUTO-GENERATED by tools/build-today.py — DO NOT EDIT BY HAND */\n")
    f.write(f"/* Snapshot: {ym_str(NOW_YM)} */\n")
    f.write("window.WP_TODAY = ")
    json.dump(payload_today, f, ensure_ascii=False, separators=(",", ":"))
    f.write(";\n")
print(f"\nWrote {OUT_TODAY} ({os.path.getsize(OUT_TODAY):,} bytes)")

# ── Output: customers-data.js (V1 第 3 刀) ───────────────────────────
payload_cust = {
    "meta": {
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "snapshot": ym_str(NOW_YM),
    },
    "summary": ci_summary,
    "buckets": [
        {
            "key": b,
            "n": bucket_agg[b]["n"],
            "ltm_amt": bucket_agg[b]["ltm_amt"],
            "aov": bucket_agg[b]["aov"],
            "repeat_pct": bucket_agg[b]["repeat_pct"],
        }
        for b in BUCKETS
    ],
    "cross": cross,
    "types": TYPES,
    "top100": ci_rows_top,
    "all": ci_rows,           # for filter computations in browser
}

with open(OUT_CUST, "w", encoding="utf-8") as f:
    f.write("/* AUTO-GENERATED by tools/build-today.py — DO NOT EDIT BY HAND */\n")
    f.write(f"/* Snapshot: {ym_str(NOW_YM)} */\n")
    f.write("window.WP_CUSTOMERS = ")
    json.dump(payload_cust, f, ensure_ascii=False, separators=(",", ":"))
    f.write(";\n")
print(f"Wrote {OUT_CUST} ({os.path.getsize(OUT_CUST):,} bytes)")
