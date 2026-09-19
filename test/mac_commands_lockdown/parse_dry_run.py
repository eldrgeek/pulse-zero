#!/usr/bin/env python3
"""Read psql or Management-API output from live_dry_run.py; print one line per
case. Exit 0 only if the DRYRUN_RESULTS marker was found and every case passed."""
import json
import re
import sys

text = sys.stdin.read()
m = re.search(r"DRYRUN_RESULTS:(\[.*?\])(?:\\n|\n|\"|$)", text, re.S)
if not m:
    print("NO DRYRUN_RESULTS marker: the migration itself failed or never ran\n" + text[:2000])
    sys.exit(2)
raw = m.group(1)
if '\\"' in raw:  # Management API returns the message JSON-escaped
    raw = json.loads('"' + raw + '"')
results = json.loads(raw)
for r in results:
    print(("PASS " if r["ok"] else "FAIL ") + r["name"] + " | " + r["detail"])
failed = [r for r in results if not r["ok"]]
print(f"{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
