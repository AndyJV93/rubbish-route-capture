#!/usr/bin/env python3
"""Fail if customer data is about to enter this public repository.

Checks every file passed on the command line (or every git-tracked file when none are
given) and exits non-zero on:

  1. A real roster:       a JSON file whose "format" is route-capture-roster, outside sample/
  2. An appearances CSV:  a line starting with Date,Day,List,Street,Number,Name
  3. A route export:      a JSON file whose "format" is route-capture-day, or a file named
                          "... Route Log ..."
  4. A denylist hit:      any whole-word match of a term in the private denylist file
                          (env ROUTE_CAPTURE_DENYLIST, default
                          ~/rubbish-billing/apps/route-capture/denylist.txt). The denylist
                          itself lives outside this repo. If the file is missing the check
                          still runs rules 1-3 and says so.

Used by the local pre-commit hook and by CI. Zero dependencies.
"""
import os
import re
import subprocess
import sys

SAMPLE_DIR = "sample/"
BINARY_EXT = (".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".pdf")


def tracked_files():
    out = subprocess.run(["git", "ls-files", "-z"], capture_output=True, check=True).stdout
    return [p.decode() for p in out.split(b"\0") if p]


def load_denylist():
    path = os.environ.get("ROUTE_CAPTURE_DENYLIST") or os.path.expanduser(
        "~/rubbish-billing/apps/route-capture/denylist.txt")
    if not os.path.exists(path):
        return None, path
    terms = [t.strip() for t in open(path, encoding="utf-8") if t.strip() and not t.startswith("#")]
    return [t for t in terms if len(t) >= 4], path


def json_format(text):
    """The "format" field if the whole file is a JSON object, else None. Source code never parses."""
    if not text.lstrip().startswith("{"):
        return None
    try:
        import json
        obj = json.loads(text)
    except ValueError:
        return None
    return obj.get("format") if isinstance(obj, dict) else None


def main(argv):
    files = argv or tracked_files()
    denylist, deny_path = load_denylist()
    patterns = [re.compile(r"\b" + re.escape(t) + r"\b") for t in (denylist or [])]
    problems = []

    for f in files:
        if f.endswith(BINARY_EXT) or not os.path.isfile(f):
            continue
        if "Route Log" in os.path.basename(f):
            problems.append(f"{f}: looks like a route export")
        try:
            text = open(f, encoding="utf-8", errors="ignore").read()
        except OSError:
            continue
        fmt = json_format(text)
        if fmt == "route-capture-roster" and not f.startswith(SAMPLE_DIR):
            problems.append(f"{f}: is a roster file (only sample/ may hold one, and only a fictional one)")
        if fmt == "route-capture-day":
            problems.append(f"{f}: is a route export")
        if re.search(r"^Date,Day,List,Street,Number,Name", text, re.M):
            problems.append(f"{f}: contains an appearances CSV")
        if f == "tools/check_no_customer_data.py":
            continue
        for p in patterns:
            m = p.search(text)
            if m:
                line = text.count("\n", 0, m.start()) + 1
                problems.append(f"{f}:{line}: denylist term \"{m.group(0)}\"")
                break

    if problems:
        print("Customer-data check FAILED:")
        for p in problems:
            print("  " + p)
        print("Remove the data (or, for a false positive, reword it) and try again.")
        return 1
    note = "" if denylist is not None else f" (denylist not found at {deny_path}: name check skipped)"
    print(f"Customer-data check passed: {len(files)} files{note}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
