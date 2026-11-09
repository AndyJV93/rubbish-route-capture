#!/usr/bin/env python3
"""Build a roster.json for the Route Order Capture app from a customer-appearances CSV.

The CSV has one row per customer per printed route sheet:
    Date,Day,List,Street,Number,Name,Flags on sheet
    2026-11-13,Fri,1,Main St,12,Example,*
Flags: "*" = roadside pickup, "$12.34" = contract price printed on the sheet,
"DELETE" = skip that day, "?" = the OCR was unsure.

Optionally a skeletons.json gives the known driver order per weekday as
[street, number] pairs; stops in it are sorted to match, stops not in it are
slotted next to their street-mates.

    python3 build_roster.py appearances.csv roster.json [--skeleton skeletons.json]
"""
import argparse
import csv
import json
import re
import sys
from collections import defaultdict
from datetime import date

DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
PRICE = re.compile(r"\$\d+(?:\.\d{2})?")


def slug(*parts):
    s = "-".join(parts).lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "x"


def house_sort_key(number):
    m = re.match(r"(\d+)", number or "")
    return (0, int(m.group(1)), number) if m else (1, 0, number)


def read_appearances(path):
    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            r = {k.strip(): (v or "").strip() for k, v in r.items()}
            if not r.get("Street"):
                continue
            rows.append(r)
    return rows


def build_day(day, rows, skeleton):
    """rows: appearances for this weekday, in CSV order (which mirrors the printed sheet)."""
    by_key = {}
    order_seen = []
    dates = sorted({r["Date"] for r in rows})
    last_sheet = dates[-1] if dates else None

    for r in rows:
        key = (r["Street"], r["Number"])
        flags = r.get("Flags on sheet", "")
        price = PRICE.search(flags)
        if key not in by_key:
            by_key[key] = {
                "id": slug(day, r["Street"], r["Number"], r["Name"]),
                "street": r["Street"],
                "number": r["Number"],
                "name": r["Name"],
                "contract": None,
                "roadside": None,
                "unsure": False,
                "seen": 0,
                "firstSeen": r["Date"],
                "lastSeen": r["Date"],
                "lastList": r["List"],
                "onLastSheet": False,
            }
            order_seen.append(key)
        s = by_key[key]
        s["seen"] += 1
        s["lastSeen"] = max(s["lastSeen"], r["Date"])
        if r["Date"] >= s["lastSeen"]:
            s["lastList"] = r["List"]
            s["name"] = r["Name"] or s["name"]
        if price:
            s["contract"] = price.group(0)
        if "*" in flags:
            s["roadside"] = True
        if "?" in flags or r["Number"] == "?":
            s["unsure"] = True

    for r in rows:
        if r["Date"] == last_sheet:
            by_key[(r["Street"], r["Number"])]["onLastSheet"] = True

    # Sheet order = order on the most recent sheet (list 1 then list 2), then
    # anything older that has dropped off, in the order it was first seen.
    last_rows = [r for r in rows if r["Date"] == last_sheet]
    sheet_order = []
    for r in last_rows:
        k = (r["Street"], r["Number"])
        if k not in sheet_order:
            sheet_order.append(k)
    for k in order_seen:
        if k not in sheet_order:
            sheet_order.append(k)

    stops = [by_key[k] for k in sheet_order]
    for s in stops:
        s["orderSource"] = "sheet"

    if skeleton:
        stops = apply_skeleton(stops, skeleton)

    return {
        "lastSheet": last_sheet,
        "sheetsSeen": len(dates),
        "skeleton": {"confirmed": skeleton.get("confirmed", False), "notes": skeleton.get("notes", "")}
        if skeleton else None,
        "stops": stops,
    }


def apply_skeleton(stops, skeleton):
    """Sort stops by the known driver order; slot unknown stops next to their street-mates."""
    order = [(st, str(n)) for st, n in skeleton["order"]]
    pos = {k: i for i, k in enumerate(order)}
    placed, unplaced = [], []
    for s in stops:
        k = (s["street"], s["number"])
        if k in pos:
            s["orderSource"] = "driver"
            placed.append((pos[k], s))
        else:
            unplaced.append(s)
    placed.sort(key=lambda t: t[0])
    result = [s for _, s in placed]

    leftovers = []
    for s in unplaced:
        mates = [i for i, p in enumerate(result) if p["street"] == s["street"]]
        if not mates:
            leftovers.append(s)
            continue
        # Slot next to the street-mate whose house number is closest: after it when
        # our number is higher, before it when lower, so runs stay in street order.
        mine = house_sort_key(s["number"])[1]
        target = min(mates, key=lambda i: abs(house_sort_key(result[i]["number"])[1] - mine))
        s["orderSource"] = "slotted"
        after = mine >= house_sort_key(result[target]["number"])[1]
        result.insert(target + 1 if after else target, s)

    for s in leftovers:
        s["orderSource"] = "unplaced"
    return result + leftovers


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("appearances_csv")
    ap.add_argument("roster_json")
    ap.add_argument("--skeleton", help="skeletons.json with known driver order per weekday")
    ap.add_argument("--label", default="", help="free-text label stored in the roster")
    args = ap.parse_args()

    rows = read_appearances(args.appearances_csv)
    skeletons = {}
    if args.skeleton:
        with open(args.skeleton, encoding="utf-8") as f:
            skeletons = {k: v for k, v in json.load(f).items() if not k.startswith("_")}

    by_day = defaultdict(list)
    for r in rows:
        by_day[r["Day"]].append(r)

    roster = {
        "format": "route-capture-roster",
        "version": 1,
        "generated": date.today().isoformat(),
        "label": args.label,
        "days": {},
    }
    for day in DAYS:
        if day in by_day:
            roster["days"][day] = build_day(day, by_day[day], skeletons.get(day))

    with open(args.roster_json, "w", encoding="utf-8") as f:
        json.dump(roster, f, indent=1, ensure_ascii=False)

    for day, d in roster["days"].items():
        on = sum(1 for s in d["stops"] if s["onLastSheet"])
        src = defaultdict(int)
        for s in d["stops"]:
            src[s["orderSource"]] += 1
        print(f"{day}: {len(d['stops'])} customers, {on} on last sheet ({d['lastSheet']}), order: {dict(src)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
