"""Office changes (holds, skips, new customers, cancels) applied on top of a day's list.

The office records a change once, on a short form, when the customer calls. The form's
responses arrive as a spreadsheet; exported as CSV they are read here by column title:

    Timestamp, Type of change, Customer last name, Street, House number,
    Access customer number, First date affected, Last date affected,
    Route day, How often, Recycling, Pickup location, Usual barrels, Note, Taken by

The customer master (the billing program) is still updated as before; this is only how the
change reaches the truck the same day. No customer data lives in this file.
"""
import csv
import re
from datetime import date, datetime

HOLD, SKIP, RESUME, NEW, CANCEL = "temporary hold", "skip one pickup", "resume early", "new customer", "cancel service"
WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
SUFFIX = {"road": "Rd", "street": "St", "lane": "Ln", "drive": "Dr", "avenue": "Ave", "circle": "Cir",
          "court": "Ct", "place": "Pl", "terrace": "Ter", "turnpike": "Tpke"}
EVERY = {"weekly": 7, "every week": 7, "every 2 weeks": 14, "every 3 weeks": 21}


def norm_street(street):
    words = " ".join((street or "").split()).split(" ")
    if words and words[-1].lower().rstrip(".") in SUFFIX:
        words[-1] = SUFFIX[words[-1].lower().rstrip(".")]
    return " ".join(words)


def parse_date(text):
    text = (text or "").strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(text.split(" ")[0], fmt).date()
        except ValueError:
            pass
    return None


def parse_stamp(text):
    text = (text or "").strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%m/%d/%Y %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            pass
    d = parse_date(text)
    return datetime(d.year, d.month, d.day) if d else datetime.min


def read_changes(path):
    out = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        for i, r in enumerate(csv.DictReader(f), start=2):
            r = {(k or "").strip(): (v or "").strip() for k, v in r.items()}
            if not r.get("Type of change"):
                continue
            out.append({
                "row": i, "stamp": parse_stamp(r.get("Timestamp")), "type": r["Type of change"].lower(),
                "name": r.get("Customer last name", ""), "street": norm_street(r.get("Street", "")),
                "number": r.get("House number", ""), "access_id": r.get("Access customer number", ""),
                "first": parse_date(r.get("First date affected")), "last": parse_date(r.get("Last date affected")),
                "day": r.get("Route day", "")[:3].title(), "every": r.get("How often", "").lower(),
                "recycling": r.get("Recycling", "").lower(), "location": r.get("Pickup location", "").lower(),
                "barrels": r.get("Usual barrels", ""), "note": r.get("Note", ""), "by": r.get("Taken by", ""),
            })
    return sorted(out, key=lambda c: c["stamp"])


def same_customer(change, stop):
    if change["access_id"] and stop.get("accessId"):
        return change["access_id"] == str(stop["accessId"])
    return (change["street"], change["number"]) == (norm_street(stop.get("street")), str(stop.get("number", "")).strip())


def covers(change, day):
    """Does a hold or skip apply on this service date?"""
    if not change["first"]:
        return False
    if change["type"] == SKIP:
        return day == change["first"]
    return change["first"] <= day and (change["last"] is None or day <= change["last"])


def new_customer_due(change, day):
    if change["type"] != NEW or not change["first"] or day < change["first"]:
        return False
    if WEEKDAYS[day.weekday()] != change["day"]:
        return False
    first_service = change["first"]
    while WEEKDAYS[first_service.weekday()] != change["day"]:
        first_service = date.fromordinal(first_service.toordinal() + 1)
    if change["every"] in EVERY:
        return (day - first_service).days % EVERY[change["every"]] == 0
    if change["every"].startswith("month"):
        return (day.day - 1) // 7 == (first_service.day - 1) // 7
    return True   # frequency not given: show it and let a person decide


def new_customer_rows(changes, day_tag, service_date, existing_keys):
    """Appearance-style rows for new customers due that day and not already on the list."""
    rows = []
    for c in changes:
        key = (c["street"], c["number"])
        if new_customer_due(c, service_date) and key not in existing_keys:
            if any(x["type"] == CANCEL and (x["street"], x["number"]) == key and x["first"] and x["first"] <= service_date
                   and x["stamp"] > c["stamp"] for x in changes):
                continue
            rows.append({"Date": service_date.isoformat(), "Day": day_tag, "List": "", "Street": c["street"],
                         "Number": c["number"], "Name": c["name"],
                         "Flags on sheet": "*" if c["location"].startswith("road") else ""})
            existing_keys.add(key)
    return rows


def apply_to_stops(stops, changes, service_date):
    """Mark holds and skips, drop cancels, tag new customers. Returns (stops, log lines)."""
    log, kept = [], []
    for s in stops:
        mine = [c for c in changes if same_customer(c, s)]
        cancel = [c for c in mine if c["type"] == CANCEL and c["first"] and c["first"] <= service_date]
        if cancel:
            log.append(f"removed (cancelled {cancel[-1]['first']}): {s['number']} {s['street']} {s['name']}")
            continue
        holds = [c for c in mine if c["type"] in (HOLD, SKIP) and covers(c, service_date)]
        if holds:
            h = holds[-1]
            resumed = [c for c in mine if c["type"] == RESUME and c["stamp"] > h["stamp"]
                       and c["first"] and c["first"] <= service_date]
            if not resumed:
                until = h["last"].isoformat() if h["last"] and h["type"] == HOLD else None
                s["hold"] = {"kind": "skip" if h["type"] == SKIP else "hold", "until": until, "note": h["note"]}
                s["onLastSheet"] = False        # tucked away in the app, one tap brings it back
                log.append(f"{'skip' if h['type'] == SKIP else 'on hold'}"
                           f"{' until ' + until if until else ''}: {s['number']} {s['street']} {s['name']}")
        new = [c for c in mine if c["type"] == NEW]
        if new:
            c = new[-1]
            s["new"] = True
            if c["recycling"] in ("yes", "no"):
                s["recycle"] = c["recycling"] == "yes"
            if c["location"]:
                s["roadside"] = c["location"].startswith("road")
            if c["note"]:
                s["officeNote"] = c["note"]
        kept.append(s)
    return kept, log


def needs_a_person(changes):
    """Changes that are never applied automatically."""
    auto = (HOLD, SKIP, RESUME, NEW, CANCEL)
    out = []
    for c in changes:
        if c["type"] not in auto:
            out.append(f"row {c['row']}: {c['type']}: {c['number']} {c['street']} {c['name']} {c['note']}".strip())
        elif not c["first"] and c["type"] != RESUME:
            out.append(f"row {c['row']}: {c['type']} has no first date: {c['number']} {c['street']} {c['name']}")
        elif not (c["street"] and c["number"]) and not c["access_id"]:
            out.append(f"row {c['row']}: {c['type']} has no address or customer number: {c['name']}")
    return out
