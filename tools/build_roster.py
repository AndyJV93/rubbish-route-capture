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
        [--extra flags.csv] [--access customers.csv]

--week YYYY-MM-DD (a Monday) with --access and --export-date builds the five weekday
lists from the billing program's schedule (see schedule.py) instead of from the sheets;
the appearances CSV is then used only for display names ("-" for none).

--changes takes the office change form's responses as CSV (see changes.py): holds and skips
are tucked away for their dates, cancels removed, new customers added and slotted by street.

--access takes the customer master exported from the office billing program, with
at least the columns "Street (tracker)", "Number (text)", "Customer ID",
"Schedule code", "Next pickup", "Recycling" (Y/N), "Pickup location code" (D/R),
"Contract" (Y/N) and "Contract rate per pickup". It fills recycle/roadside/contract
where the sheets left them blank and adds accessId/schedule/nextPickup to each stop.
Truck observations from --extra are applied last and win.
"""
import argparse
import csv
import json
import re
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import changes as office  # noqa: E402
import schedule  # noqa: E402

DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
PRICE = re.compile(r"\$\d+(?:\.\d{2})?")


def slug(*parts):
    s = "-".join(parts).lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "x"


def house_sort_key(number):
    m = re.match(r"(\d+)", number or "")
    return (0, int(m.group(1)), number) if m else (1, 0, number)


def parse_flag(v):
    """'1'/'yes'/'true' -> True, '0'/'no'/'false' -> False, blank -> None, else the text."""
    low = v.lower()
    if low in ("1", "yes", "true", "y"):
        return True
    if low in ("0", "no", "false", "n"):
        return False
    return v or None


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


def apply_access(stop, a):
    """Fill a stop from the billing program's customer row; sheet flags already set are kept."""
    stop["accessId"] = a.get("Customer ID") or None
    stop["schedule"] = a.get("Schedule code") or None
    stop["nextPickup"] = a.get("Next pickup") or None
    if a.get("Recycling", "").upper() in ("Y", "N"):
        stop["recycle"] = a["Recycling"].upper() == "Y"
    loc = a.get("Pickup location code", "").upper()
    if stop.get("roadside") is None and loc in ("R", "D"):
        stop["roadside"] = loc == "R"
    rate = a.get("Contract rate per pickup", "")
    if not stop.get("contract") and a.get("Contract", "").upper() == "Y" and rate:
        try:
            stop["contract"] = f"${float(rate):.2f}"
        except ValueError:
            stop["contract"] = rate


def display_name(raw):
    """Upper-case names from the billing program to display case: SAMPLE -> Sample, MCTEST -> McTest."""
    raw = (raw or "").strip()
    if raw != raw.upper():          # already mixed case: someone typed it the way they want it
        return raw
    out = re.sub(r"[A-Za-z]+", lambda m: m.group(0).capitalize(), raw)
    return re.sub(r"\bMc([a-z])", lambda m: "Mc" + m.group(1).upper(), out)


def predicted_rows(access_rows, monday, export_date, names, dormant_days=56):
    """Appearance-style rows for one week, from the schedule. names: {(street, number): display name}."""
    rows, held = [], []
    horizon = schedule.printed_through(access_rows)
    for day in schedule.week_days(monday):
        tag = schedule.WEEKDAYS[day.weekday()]
        for a in schedule.held_on(access_rows, day, export_date, dormant_days, horizon):
            held.append((tag, a["Street (tracker)"], a["Number (text)"], a.get("Temp stop end", "")))
        due = schedule.due_on(access_rows, day, export_date, dormant_days, horizon)
        due.sort(key=lambda a: (a.get("Route list", ""), a["Street (tracker)"], house_sort_key(a["Number (text)"])))
        for a in due:
            key = (a["Street (tracker)"], a["Number (text)"])
            lists = [x.strip() for x in a.get("Route list", "").split(";") if x.strip().startswith(tag)]
            rows.append({"Date": day.isoformat(), "Day": tag,
                         "List": (lists[0][-1:] if lists else ""),
                         "Street": key[0], "Number": key[1],
                         "Name": names.get(key) or display_name(a.get("Last name")),
                         "Flags on sheet": ""})
    return rows, held


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("appearances_csv")
    ap.add_argument("roster_json")
    ap.add_argument("--skeleton", help="skeletons.json with known driver order per weekday")
    ap.add_argument("--extra", help="CSV of extra per-customer fields keyed by Day,Street,Number "
                                    "(e.g. recycle: 1 = yes, 0 = no, blank = unknown)")
    ap.add_argument("--access", help="CSV exported from the billing program's customer table "
                                     "(see module docstring for the columns used)")
    ap.add_argument("--changes", help="CSV of the office change form's responses (holds, skips, new customers, cancels)")
    ap.add_argument("--week", help="Monday (YYYY-MM-DD): build that week from the schedule in --access")
    ap.add_argument("--export-date", help="date the --access file was exported (YYYY-MM-DD); needed with --week")
    ap.add_argument("--dormant-days", type=int, default=56,
                    help="with --week: skip customers not charged in this many days before the export")
    ap.add_argument("--label", default="", help="free-text label stored in the roster")
    args = ap.parse_args()

    rows = [] if args.appearances_csv == "-" else read_appearances(args.appearances_csv)
    held = []
    if args.week:
        if not (args.access and args.export_date):
            ap.error("--week needs --access and --export-date")
        with open(args.access, newline="", encoding="utf-8") as f:
            access_rows = [{k.strip(): (v or "").strip() for k, v in r.items()} for r in csv.DictReader(f)]
        names = {(r["Street"], r["Number"]): r["Name"] for r in rows if r.get("Name")}
        rows, held = predicted_rows(access_rows, date.fromisoformat(args.week),
                                    date.fromisoformat(args.export_date), names, args.dormant_days)
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
    if args.week:
        roster["source"] = {"kind": "schedule", "week": args.week, "exportDate": args.export_date}
    extra = {}
    if args.extra:
        with open(args.extra, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                r = {k.strip(): (v or "").strip() for k, v in r.items()}
                fields = {k: parse_flag(v) for k, v in r.items()
                          if k not in ("Day", "Street", "Number", "note")}
                extra[(r["Day"], r["Street"], r["Number"])] = fields

    access = {}
    if args.access:
        with open(args.access, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                r = {k.strip(): (v or "").strip() for k, v in r.items()}
                access[(r["Street (tracker)"], r["Number (text)"])] = r

    changes = office.read_changes(args.changes) if args.changes else []
    change_log = []
    unmatched = []
    for day in DAYS:
        if day in by_day:
            service_date = date.fromisoformat(max(r["Date"] for r in by_day[day]))
            if changes:
                keys = {(r["Street"], r["Number"]) for r in by_day[day] if r["Date"] == service_date.isoformat()}
                added = office.new_customer_rows(changes, day, service_date, keys)
                by_day[day] += added
                change_log += [f"{day}: new customer added: {r['Number']} {r['Street']} {r['Name']}" for r in added]
            d = build_day(day, by_day[day], skeletons.get(day))
            for s in d["stops"]:
                s.setdefault("recycle", None)
                a = access.get((s["street"], s["number"]))
                if a:
                    apply_access(s, a)
                elif access:
                    unmatched.append((day, s["street"], s["number"], s["name"]))
                # truck observations win, but a blank in the extra file is "no information"
                s.update({k: v for k, v in extra.get((day, s["street"], s["number"]), {}).items()
                          if v is not None})
            if changes:
                d["stops"], log = office.apply_to_stops(d["stops"], changes, service_date)
                change_log += [f"{day}: {line}" for line in log]
            roster["days"][day] = d
    for line in change_log:
        print("office change:", line, file=sys.stderr)
    for line in office.needs_a_person(changes):
        print("office change needs a person:", line, file=sys.stderr)
    if unmatched:
        print(f"{len(unmatched)} stops have no row in the --access file:", file=sys.stderr)
        for u in unmatched:
            print("   ", *u, file=sys.stderr)

    with open(args.roster_json, "w", encoding="utf-8") as f:
        json.dump(roster, f, indent=1, ensure_ascii=False)

    for h in held:
        print("on hold, left off:", *h, file=sys.stderr)
    for day, d in roster["days"].items():
        on = sum(1 for s in d["stops"] if s["onLastSheet"])
        src = defaultdict(int)
        for s in d["stops"]:
            src[s["orderSource"]] += 1
        print(f"{day}: {len(d['stops'])} customers, {on} on last sheet ({d['lastSheet']}), order: {dict(src)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
