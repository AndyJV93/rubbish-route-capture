"""Tests for the schedule-driven list generator. Every customer here is invented."""
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import build_roster  # noqa: E402
import schedule  # noqa: E402

EXPORT = date(2026, 1, 5)          # a Monday
COLS = ["Street (tracker)", "Number (text)", "Customer ID", "Last name", "Schedule code", "Pickup day(s)",
        "Route list", "Next pickup", "Last pickup charged", "On call", "Contract", "Contract rate per pickup",
        "Recycling", "Pickup location code", "Temp stop start", "Temp stop end", "Review note"]


def cust(cid, name, street, number, code, day, nxt, last="2026-01-02", **kw):
    row = dict.fromkeys(COLS, "")
    row.update({"Customer ID": str(cid), "Last name": name, "Street (tracker)": street, "Number (text)": number,
                "Schedule code": code, "Pickup day(s)": day, "Route list": f"{day.split('/')[0]} list 1",
                "Next pickup": nxt, "Last pickup charged": last, "On call": "N", "Contract": "N",
                "Recycling": "Y", "Pickup location code": "D"})
    row.update(kw)
    return row


CUSTOMERS = [
    cust(1, "WEEKLY", "Maple Rd", "4", "B1", "Mon", "2026-01-12"),
    cust(2, "BIWEEKLY-ON", "Maple Rd", "11", "B2", "Mon", "2026-01-12"),
    cust(3, "BIWEEKLY-OFF", "Maple Rd", "15", "B2", "Mon", "2026-01-19"),
    cust(4, "THREEWEEK", "Oak Ln", "3", "B3", "Mon", "2026-01-26"),
    cust(5, "MONTHLY", "Oak Ln", "9", "C1", "Tue", "2026-02-03"),          # first Tuesday
    cust(6, "MULTI", "Pine St", "8", "A246", "Mon/Wed/Fri", "2026-01-12",
         **{"Route list": "Mon list 1; Wed list 2; Fri list 1", "Contract": "Y", "Contract rate per pickup": "67.63"}),
    cust(7, "DORMANT", "Elm St", "1", "B1", "Mon", "2026-01-12", last="2025-06-01"),
    cust(8, "STOPPED", "Elm St", "2", "B1", "Mon", "2026-01-12", **{"Review note": "Permanent stop 12/01/2025"}),
    cust(9, "ONCALL", "Elm St", "3", "B1", "Mon", "2026-01-12", **{"On call": "Y"}),
    cust(10, "AWAY", "Elm St", "4", "B1", "Mon", "2026-01-12",
         **{"Temp stop start": "2026-01-10", "Temp stop end": "2026-01-20", "Pickup location code": "R"}),
    cust(11, "NOCODE", "Elm St", "5", "", "Mon", ""),
    cust(13, "PUSHEDOUT", "Elm St", "7", "B1", "Mon", "2026-01-26"),     # office skipped two weeks
    cust(12, "NEVERCHARGED", "Elm St", "6", "B1", "Mon", "2026-01-12", last=""),
]


def names(day):
    return sorted(r["Last name"] for r in schedule.due_on(CUSTOMERS, day, EXPORT))


class DueTest(unittest.TestCase):
    def test_weekly_and_alternating_weeks(self):
        self.assertEqual(names(date(2026, 1, 12)), ["BIWEEKLY-ON", "MULTI", "WEEKLY"])
        self.assertEqual(names(date(2026, 1, 19)), ["BIWEEKLY-OFF", "MULTI", "WEEKLY"])
        self.assertEqual(names(date(2026, 1, 26)), ["AWAY", "BIWEEKLY-ON", "MULTI", "PUSHEDOUT", "THREEWEEK", "WEEKLY"])

    def test_pushed_out_next_pickup_means_not_due_before_it(self):
        row = next(r for r in CUSTOMERS if r["Last name"] == "PUSHEDOUT")
        self.assertEqual(schedule.due_reason(row, date(2026, 1, 12), EXPORT), (False, "before next pickup date"))
        self.assertEqual(schedule.due_reason(row, date(2026, 1, 19), EXPORT), (False, "before next pickup date"))
        self.assertEqual(schedule.due_reason(row, date(2026, 1, 26), EXPORT), (True, ""))
        self.assertEqual(schedule.due_reason(row, date(2026, 2, 2), EXPORT), (True, ""))

    def test_cycles_work_backwards_from_next_pickup(self):
        self.assertEqual(names(date(2026, 1, 5)), ["AWAY", "BIWEEKLY-OFF", "MULTI", "PUSHEDOUT", "THREEWEEK", "WEEKLY"])

    def test_three_week_cycle(self):
        on = [d for d in (date(2026, 1, 5), date(2026, 1, 12), date(2026, 1, 19), date(2026, 1, 26), date(2026, 2, 16))
              if "THREEWEEK" in names(d)]
        self.assertEqual(on, [date(2026, 1, 5), date(2026, 1, 26), date(2026, 2, 16)])

    def test_monthly_is_same_weekday_of_month(self):
        tuesdays = [date(2026, 1, 6), date(2026, 1, 13), date(2026, 2, 3), date(2026, 2, 10), date(2026, 3, 3)]
        # looking forward from the export, nothing is due before the next pickup date
        self.assertEqual([d for d in tuesdays if "MONTHLY" in names(d)], [date(2026, 2, 3), date(2026, 3, 3)])
        # lists up to the horizon were already printed, so the cycle is read backwards there
        back = [d for d in tuesdays if any(r["Last name"] == "MONTHLY"
                for r in schedule.due_on(CUSTOMERS, d, EXPORT, horizon=date(2026, 1, 9)))]
        self.assertEqual(back, [date(2026, 1, 6), date(2026, 2, 3), date(2026, 3, 3)])

    def test_printed_through_is_the_latest_charge(self):
        self.assertEqual(schedule.printed_through(CUSTOMERS), date(2026, 1, 2))
        self.assertIsNone(schedule.printed_through([{"Last pickup charged": ""}]))

    def test_multi_day_code(self):
        self.assertEqual(schedule.weekdays_of(CUSTOMERS[5]), [0, 2, 4])
        self.assertIn("MULTI", names(date(2026, 1, 14)))
        self.assertNotIn("MULTI", names(date(2026, 1, 13)))

    def test_reasons_for_leaving_someone_off(self):
        day = date(2026, 1, 12)
        why = {r["Last name"]: schedule.due_reason(r, day, EXPORT)[1] for r in CUSTOMERS}
        self.assertEqual(why["DORMANT"], "dormant or permanently stopped")
        self.assertEqual(why["STOPPED"], "dormant or permanently stopped")
        self.assertEqual(why["NEVERCHARGED"], "dormant or permanently stopped")
        self.assertEqual(why["ONCALL"], "on call")
        self.assertEqual(why["AWAY"], "on hold")
        self.assertEqual(why["NOCODE"], "no schedule code")
        self.assertEqual(why["BIWEEKLY-OFF"], "before next pickup date")
        off = next(r for r in CUSTOMERS if r["Last name"] == "BIWEEKLY-OFF")
        self.assertEqual(schedule.due_reason(off, date(2026, 1, 26), EXPORT), (False, "off week"))
        self.assertEqual(why["MONTHLY"], "not this weekday")
        self.assertEqual([r["Last name"] for r in schedule.held_on(CUSTOMERS, day, EXPORT)], ["AWAY"])

    def test_week_must_start_on_monday(self):
        with self.assertRaises(ValueError):
            schedule.week_days(date(2026, 1, 13))


class RosterTest(unittest.TestCase):
    def build(self, extra_args=()):
        import csv
        with tempfile.TemporaryDirectory() as tmp:
            acc, out = Path(tmp) / "access.csv", Path(tmp) / "roster.json"
            with open(acc, "w", newline="") as f:
                w = csv.DictWriter(f, fieldnames=COLS)
                w.writeheader()
                w.writerows(CUSTOMERS)
            res = subprocess.run([sys.executable, str(ROOT / "tools" / "build_roster.py"), "-", str(out), "--access", str(acc),
                                  "--week", "2026-01-12", "--export-date", "2026-01-05", *extra_args],
                                 capture_output=True, text=True)
            self.assertEqual(res.returncode, 0, res.stderr)
            return json.loads(out.read_text()), res.stderr

    def test_week_roster_from_schedule(self):
        roster, err = self.build()
        self.assertEqual(sorted(roster["days"]), ["Fri", "Mon", "Wed"])   # nobody is due Tue or Thu this week
        mon = roster["days"]["Mon"]
        self.assertEqual([s["name"] for s in mon["stops"]], ["Weekly", "Biweekly-On", "Multi"])
        self.assertEqual(mon["lastSheet"], "2026-01-12")
        self.assertTrue(all(s["onLastSheet"] for s in mon["stops"]))
        multi = mon["stops"][2]
        self.assertEqual((multi["contract"], multi["recycle"], multi["roadside"], multi["accessId"], multi["lastList"]),
                         ("$67.63", True, False, "6", "1"))
        self.assertEqual(roster["days"]["Wed"]["stops"][0]["lastList"], "2")
        self.assertEqual(roster["source"], {"kind": "schedule", "week": "2026-01-12", "exportDate": "2026-01-05"})
        self.assertIn("on hold, left off: Mon Elm St 4 2026-01-20", err)

    def test_roster_passes_the_app_validator(self):
        roster, _ = self.build()
        ids = [s["id"] for d in roster["days"].values() for s in d["stops"]]
        self.assertEqual(roster["format"], "route-capture-roster")
        for d in roster["days"].values():
            day_ids = [s["id"] for s in d["stops"]]
            self.assertEqual(len(day_ids), len(set(day_ids)))
        self.assertTrue(all(ids))

    def test_display_names(self):
        self.assertEqual([build_roster.display_name(x) for x in ("SAMPLE", "ALPHA-BRAVO", "O'TESTER", "MCTEST", "MixedCase Inc")],
                         ["Sample", "Alpha-Bravo", "O'Tester", "McTest", "MixedCase Inc"])


if __name__ == "__main__":
    unittest.main()
