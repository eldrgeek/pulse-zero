#!/usr/bin/env python3
"""package-demo.py — stage a _estate/bin/demo-record output (player.html +
meta.json) into the auth-gated demos manifest served by
netlify/functions/review-demo.js.

WHY THIS EXISTS
  R2b evidence requirement: a report card's demo needs a live URL Mike can
  click, but the recording itself narrates internal review detail — it sits
  behind the same owner gate as /review/, so player.html is never a static
  file under public/ (same reasoning as review/build-findings.py for the
  findings JSON/screenshots). This packs it into
  netlify/functions/review-demos-files/manifest.json (slug -> {html_b64, meta})
  instead, gated server-side by review-demo.js.

USAGE
  python3 review/package-demo.py <demo-dir> [--caption "one line"]
  e.g. python3 review/package-demo.py \
    ~/Projects/_estate/demos/2026-08-15-pulse-zero-r2b-findings-demo \
    --caption "Sign in, expand a finding, filter by lane — 4 narrated steps"
"""
import argparse
import base64
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # pulse-zero/
MANIFEST_PATH = ROOT / "netlify" / "functions" / "review-demos-files" / "manifest.json"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("demo_dir")
    ap.add_argument("--caption", default=None)
    args = ap.parse_args()

    demo_dir = Path(args.demo_dir).expanduser().resolve()
    player = demo_dir / "player.html"
    meta_path = demo_dir / "meta.json"
    if not player.exists():
        raise SystemExit(f"no player.html at {player}")
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    slug = meta.get("slug") or demo_dir.name

    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    manifest = {}
    if MANIFEST_PATH.exists():
        manifest = json.loads(MANIFEST_PATH.read_text())

    html_b64 = base64.b64encode(player.read_bytes()).decode("ascii")
    manifest[slug] = {
        "html_b64": html_b64,
        "meta": {
            "slug": slug,
            "date": meta.get("date"),
            "url": meta.get("url"),
            "caption": args.caption or meta.get("caption"),
            "narration": meta.get("narration"),
            "durationMs": meta.get("durationMs"),
            "verify": meta.get("verify"),
            "sizeBytes": len(player.read_bytes()),
        },
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2))
    total_kb = MANIFEST_PATH.stat().st_size / 1024
    print(f"packaged {slug} ({len(html_b64) / 1024:.0f} KB base64) into {MANIFEST_PATH} ({total_kb:.0f} KB total)")


if __name__ == "__main__":
    main()
