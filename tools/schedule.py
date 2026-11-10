"""Who is due on a given day, from the billing program's customer export.

Pure functions over rows of the customer CSV (see build_roster.py --access for the
columns). No customer data lives in this file; tests use invented customers.

Schedule codes:
    B1 / B2 / B3   every 1 / 2 / 3 weeks on the same weekday, anchored on "Next pickup"
    C1             monthly, same weekday-of-month as "Next pickup" (e.g. first Tuesday)
    A + digits     several fixed weekdays every week; 2=Mon ... 6=Fri (A246 = Mon, Wed, Fri)
"""
from datetime import date, timedelta

WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
WEEKS = {"B1": 1, "B2": 2, "B3": 3}


def parse_date(s):
    try:
        return date.fromisoformat((s or "").strip())
    except ValueError:
        return None


def weekdays_of(row):
    """Weekday indexes (Mon=0) the customer is served on."""
    code = (row.get("Schedule code") or "").strip().upper()
    if code.startswith("A") and code[1:].isdigit():
        return sorted({int(ch) - 2 for ch in code[1:] if "2" <= ch <= "8"})
    days = [d.strip() for d in (row.get("Pickup day(s)") or "").replace(",", "/").split("/")]
    return sorted({WEEKDAYS.index(d) for d in days if d in WEEKDAYS})


def nth_weekday(d):
    """(n, weekday): 2026-12-01 is the 1st Tuesday -> (1, 1)."""
    return (d.day - 1) // 7 + 1, d.weekday()


def is_live(row, export_date, dormant_days=56):
    """Active in practice: charged a pickup recently and not permanently stopped."""
    if "permanent stop" in (row.get("Review note") or "").lower():
        return False
    last = parse_date(row.get("Last pickup charged"))
    return bool(last) and last >= export_date - timedelta(days=dormant_days)


def on_hold(row, day):
    start, end = parse_date(row.get("Temp stop start")), parse_date(row.get("Temp stop end"))
    return bool(start and end and start <= day <= end)


def printed_through(rows):
    """Latest list date already printed when the file was exported. The billing program records the
    charge, and moves "Next pickup" on, when a list is printed, which can be days ahead."""
    dates = [d for d in (parse_date(r.get("Last pickup charged")) for r in rows) if d]
    return max(dates) if dates else None


def due_reason(row, day, export_date, dormant_days=56, horizon=None):
    """Return (due, reason). reason says why not when due is False.

    horizon: last date whose list was already printed at export time (see printed_through);
    defaults to the export date."""
    code = (row.get("Schedule code") or "").strip().upper()
    nxt = parse_date(row.get("Next pickup"))
    if not code:
        return False, "no schedule code"
    if (row.get("On call") or "").strip().upper() == "Y":
        return False, "on call"
    if day.weekday() not in weekdays_of(row):
        return False, "not this weekday"
    if not is_live(row, export_date, dormant_days):
        return False, "dormant or permanently stopped"
    if on_hold(row, day):
        return False, "on hold"
    if code.startswith("A"):
        return True, ""
    if not nxt:
        return False, "no next pickup date"
    if (horizon or export_date) < day < nxt:
        # The office skips a pickup by pushing "Next pickup" out. Looking forward, nothing is
        # due before that date. (Looking back over past weeks this cannot be seen, so a
        # back-test will list a customer who was skipped that way.)
        return False, "before next pickup date"
    if code in WEEKS:
        due = (nxt - day).days % (7 * WEEKS[code]) == 0
        return due, "" if due else "off week"
    if code == "C1":
        due = nth_weekday(day) == nth_weekday(nxt)
        return due, "" if due else "not this week of the month"
    return False, f"unknown schedule code {code}"


def due_on(rows, day, export_date, dormant_days=56, horizon=None):
    return [r for r in rows if due_reason(r, day, export_date, dormant_days, horizon)[0]]


def held_on(rows, day, export_date, dormant_days=56, horizon=None):
    """Customers who would be due but for a temporary stop: worth showing the driver."""
    return [r for r in rows if due_reason(r, day, export_date, dormant_days, horizon) == (False, "on hold")]


def week_days(monday):
    if monday.weekday() != 0:
        raise ValueError(f"{monday} is not a Monday")
    return [monday + timedelta(days=i) for i in range(5)]
