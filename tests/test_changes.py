"""Tests for office changes applied to a day's list. Every customer here is invented."""
import csv
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import changes as office  # noqa: E402

COLS = ["Timestamp", "Type of change", "Customer last name", "Street", "House number", "Access customer number",
        "First date affected", "Last date affected", "Route day", "How often", "Recycling", "Pickup location",
        "Usual barrels", "Note", "Taken by"]


def change(stamp, kind, name, street, number, first="", last="", **kw):
    row = dict.fromkeys(COLS, "")
    row.update({"Timestamp": stamp, "Type of change": kind, "Customer last name": name, "Street": street,
                "House number": number, "First date affected": first, "Last date affected": last, "Taken by": "Tester"})
    row.update(kw)
    return row


CHANGES = [
    change("1/6/2026 9:00:00", "Temporary hold", "Away", "Maple Road", "4", "1/10/2026", "1/20/2026", Note="in Florida"),
    change("1/6/2026 9:05:00", "Skip one pickup", "Skipper", "Maple Rd", "11", "1/12/2026"),
    change("1/6/2026 9:10:00", "New customer", "Newcomer", "Maple Rd", "8", "1/12/2026", "",
           **{"Route day": "Monday", "How often": "Every 2 weeks", "Recycling": "Yes", "Pickup location": "Roadside"}),
    change("1/6/2026 9:15:00", "Cancel service", "Gone", "Oak Ln", "3", "1/12/2026"),
    change("1/6/2026 9:20:00", "Temporary hold", "Backsoon", "Oak Ln", "9", "1/5/2026", "1/30/2026"),
    change("1/8/2026 9:00:00", "Resume early", "Backsoon", "Oak Ln", "9", "1/12/2026"),
    change("1/6/2026 9:30:00", "Schedule change", "Switcher", "Oak Ln", "12", "1/12/2026", Note="weekly to every 2 weeks"),
    change("1/6/2026 9:40:00", "Temporary hold", "Nodate", "Oak Ln", "14"),
]
APPEARANCES = [("Maple Rd", "4", "Away"), ("Maple Rd", "11", "Skipper"), ("Maple Rd", "15", "Regular"),
               ("Oak Ln", "3", "Gone"), ("Oak Ln", "9", "Backsoon"), ("Oak Ln", "12", "Switcher")]


def write_csv(path, cols, rows):
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)


class ChangesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        write_csv(self.dir / "changes.csv", COLS, CHANGES)
        self.changes = office.read_changes(self.dir / "changes.csv")

    def build(self, monday):
        write_csv(self.dir / "app.csv", ["Date", "Day", "List", "Street", "Number", "Name", "Flags on sheet"],
                  [{"Date": monday, "Day": "Mon", "List": "1", "Street": s, "Number": n, "Name": nm, "Flags on sheet": ""}
                   for s, n, nm in APPEARANCES])
        (self.dir / "skel.json").write_text(json.dumps({"Mon": {"confirmed": True, "order": [[s, n] for s, n, _ in APPEARANCES]}}))
        res = subprocess.run([sys.executable, str(ROOT / "tools" / "build_roster.py"), str(self.dir / "app.csv"),
                              str(self.dir / "roster.json"), "--changes", str(self.dir / "changes.csv"),
                              "--skeleton", str(self.dir / "skel.json")],
                             capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stderr)
        stops = json.loads((self.dir / "roster.json").read_text())["days"]["Mon"]["stops"]
        return {s["name"]: s for s in stops}, [s["name"] for s in stops], res.stderr

    def test_reading(self):
        c = self.changes[0]
        self.assertEqual((c["type"], c["street"], c["first"], c["last"]),
                         ("temporary hold", "Maple Rd", date(2026, 1, 10), date(2026, 1, 20)))
        self.assertEqual(self.changes[-1]["type"], "resume early")      # sorted by time entered

    def test_week_inside_the_hold(self):
        by, order, err = self.build("2026-01-12")
        self.assertEqual(by["Away"]["hold"], {"kind": "hold", "until": "2026-01-20", "note": "in Florida"})
        self.assertFalse(by["Away"]["onLastSheet"])
        self.assertEqual(by["Skipper"]["hold"]["kind"], "skip")
        self.assertFalse(by["Skipper"]["onLastSheet"])
        self.assertNotIn("Gone", by)
        self.assertNotIn("hold", by["Backsoon"])                        # resumed early
        self.assertTrue(by["Regular"]["onLastSheet"])
        new = by["Newcomer"]
        self.assertEqual((new["new"], new["recycle"], new["roadside"], new["onLastSheet"]), (True, True, True, True))
        self.assertLess(order.index("Away"), order.index("Newcomer"))   # 8 slots between 4 and 11 by house number
        self.assertLess(order.index("Newcomer"), order.index("Skipper"))
        self.assertIn("office change: Mon: on hold until 2026-01-20: 4 Maple Rd Away", err)
        self.assertIn("office change: Mon: removed (cancelled 2026-01-12): 3 Oak Ln Gone", err)
        self.assertIn("needs a person: row 8: schedule change: 12 Oak Ln Switcher", err)
        self.assertIn("needs a person: row 9: temporary hold has no first date", err)

    def test_week_after_the_hold(self):
        by, _, _ = self.build("2026-01-26")
        self.assertNotIn("hold", by["Away"])
        self.assertNotIn("hold", by["Skipper"])                         # the skip was for one date only
        self.assertIn("Newcomer", by)                                   # every 2 weeks from Jan 12
        self.assertNotIn("Gone", by)

    def test_new_customer_off_week_and_before_start(self):
        by, _, _ = self.build("2026-01-19")
        self.assertNotIn("Newcomer", by)
        by, _, _ = self.build("2026-01-05")
        self.assertNotIn("Newcomer", by)
        self.assertNotIn("hold", by["Away"])                            # hold starts Jan 10
        self.assertIn("Gone", by)                                       # cancel takes effect Jan 12
        self.assertIn("hold", by["Backsoon"])                           # not yet resumed on Jan 5

    def test_match_by_customer_number_beats_address(self):
        c = dict(self.changes[0], access_id="77")
        self.assertTrue(office.same_customer(c, {"accessId": "77", "street": "Elsewhere St", "number": "1"}))
        self.assertFalse(office.same_customer(c, {"accessId": "78", "street": "Maple Rd", "number": "4"}))

    def test_monthly_new_customer(self):
        c = dict(self.changes[2], every="monthly", first=date(2026, 1, 12), day="Mon")
        due = [d for d in (date(2026, 1, 12), date(2026, 1, 19), date(2026, 2, 9), date(2026, 2, 16)) if office.new_customer_due(c, d)]
        self.assertEqual(due, [date(2026, 1, 12), date(2026, 2, 9)])


if __name__ == "__main__":
    unittest.main()
