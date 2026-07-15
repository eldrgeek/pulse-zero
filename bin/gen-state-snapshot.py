#!/usr/bin/env python3
"""gen-state-snapshot.py — regenerate netlify/functions/state-snapshot.json from
~/Projects/ESTATE.md's changelog. Run at deploy time (or manually) and commit
the result; the estate-state function bundles this file and merges it with a
live pulse_cards query.
"""
import json
import os
import re

ESTATE_MD = os.path.expanduser("~/Projects/ESTATE.md")
OUT = os.path.join(os.path.dirname(__file__), "..", "netlify", "functions", "state-snapshot.json")

LIVE_URLS = [
    {"name": "Pulse Zero", "url": "https://pulse-zero.netlify.app"},
    {"name": "SOMA hub (AGI-2026)", "url": "https://minds-aligned-hub.netlify.app"},
    {"name": "Momentum (INTOO)", "url": "https://momentum-demo-esr.netlify.app"},
]


def main():
    text = open(ESTATE_MD).read()
    m = re.search(r"## Changelog\n\n(.*)", text, re.S)
    body = m.group(1)
    entries = re.split(r"\n(?=### )", body)
    changelog = []
    for e in entries[:10]:
        heading = e.strip().split("\n")[0].lstrip("# ").strip()
        changelog.append(heading)

    snapshot = {
        "generated_at": None,  # stamped by caller if needed; not required for Talk answers
        "changelog": changelog,
        "live_urls": LIVE_URLS,
    }
    with open(OUT, "w") as f:
        json.dump(snapshot, f, indent=2)
    print(f"wrote {OUT} ({len(changelog)} changelog entries)")


if __name__ == "__main__":
    main()
