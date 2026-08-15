#!/usr/bin/env python3
"""build-findings.py — turn the 3-lane adversarial review markdown files into a
drillable JSON index served ONLY through an authenticated Netlify function
(never as a static file under public/) — the findings name internals
(fix mechanisms, before/after screenshots) so they sit behind the same owner
gate as the board itself, enforced server-side, not just by client JS.

WHY THIS EXISTS
  Mike's board standard (R2b, SOMA/specs/handshake-protocol-v1.md): a report
  card's bare count ("43 findings fixed") is a named anti-pattern with no path
  to the detail. This script is the "path to the detail" — it is NOT run at
  Netlify deploy time (this repo has no build step, `publish = "public"`
  ships as-is); run it by hand (or from a dispatch script) whenever the review
  markdown changes, then commit its output like any other static asset.

USAGE
  python3 review/build-findings.py

OUTPUT (all outside public/ — never directly web-reachable)
  netlify/functions/review-data/findings.json   — parsed, filterable index;
    required by netlify/functions/review-data.js, which gates it on a
    verified Supabase owner session before returning it.
  netlify/functions/review-assets/manifest.json — {"shots/<name>.png": base64,
    "shots-after/<name>.png": base64}; required by
    netlify/functions/review-asset.js, same gate, streamed with the right
    Content-Type only to a verified owner request.

PARSING MODEL (deliberately generic, not a real markdown parser)
  Each source file is split into headings of level 2 (##) and level 3 (###).
  A heading's "body" is everything up to the next heading of level <= its own.
  For each heading we best-effort-extract:
    - a leading number ("1.", "1a.") if present
    - a bracketed severity tag ("[BLOCKS-MIKE]") if present in the title
    - for UX-style files (severity as a lane heading, not inline), the
      nearest preceding level-2 heading is used as the severity fallback
    - a status word from the first blockquote line starting "> **WORD**"
      (FIXED / WONT-FIX / ANNOTATED / EXTENDED / etc.)
    - a commit hash if the body contains `commit `xxxxxxxx`` or a bare
      7-12 char hex token in backticks near the word "commit"
    - every `<name>.png` token in the body, split into before/after by
      whether review/shots/<name>.png or review/shots-after/<name>.png
      actually exists on disk
  This is a heuristic extractor for a browsing UI, not a source of truth —
  the full raw section text is always carried through as `body_md` so
  nothing is lost even where the heuristics miss.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # pulse-zero/
REVIEW = ROOT / "review"
OUT_DATA_DIR = ROOT / "netlify" / "functions" / "review-data"
OUT_ASSETS_DIR = ROOT / "netlify" / "functions" / "review-assets"

FILES = [
    ("UX", REVIEW / "UX-FINDINGS-2026-08-14.md"),
    ("CODE", REVIEW / "CODE-FINDINGS-2026-08-14.md"),
    ("DATA", REVIEW / "DATA-FINDINGS-2026-08-14.md"),
]

HEADING_RE = re.compile(r'^(#{2,3})\s+(.*)$')
NUM_RE = re.compile(r'^(\d+[a-z]?)\.\s*(.*)$')
BRACKET_RE = re.compile(r'^\[([A-Z][A-Za-z0-9/,\- ]*)\]\s*(.*)$')
STATUS_RE = re.compile(r'^>\s*\*\*([A-Z][A-Za-z0-9 ,/\-\(\)]+?)\*\*')
PNG_RE = re.compile(r'\b([A-Za-z0-9_-]+\.png)\b')
COMMIT_RE = re.compile(r'commit\s+`([0-9a-fA-F]{6,40})`|`([0-9a-fA-F]{7,12})`(?=[^`]*\bcommit|\))')


def slugify(text):
    s = re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')
    return s[:80] or 'section'


def split_headings(text):
    """Return list of {level, raw_title, body, has_children} in document order.

    `body` stops at the NEXT heading of ANY level (not just <= this one) so a
    level-2 container (e.g. UX's "## BLOCKS-MIKE" lane grouping, or DATA's
    "## 1. Rot class inventory..." wrapping 1a/1b/1c) does not duplicate its
    children's full text into its own body_md. `has_children` records whether
    a deeper heading was skipped this way, so the UI can tell a real
    leaf-finding from a pure section header.
    """
    lines = text.split('\n')
    headings = []
    for i, line in enumerate(lines):
        m = HEADING_RE.match(line)
        if m:
            headings.append({'level': len(m.group(1)), 'raw_title': m.group(2).strip(), 'line_idx': i})
    sections = []
    for idx, h in enumerate(headings):
        start = h['line_idx'] + 1
        end = len(lines)
        has_children = False
        for nxt in headings[idx + 1:]:
            end = nxt['line_idx']
            if nxt['level'] > h['level']:
                has_children = True
            break
        body = '\n'.join(lines[start:end]).strip('\n')
        sections.append({'level': h['level'], 'raw_title': h['raw_title'], 'body': body, 'has_children': has_children})
    return sections


def extract_status(body):
    for line in body.split('\n'):
        m = STATUS_RE.match(line.strip())
        if m:
            return m.group(1).strip()
    return None


def extract_commit(body):
    m = COMMIT_RE.search(body)
    if not m:
        return None
    return m.group(1) or m.group(2)


def extract_pngs(body):
    return sorted(set(PNG_RE.findall(body)))


def build():
    findings = []
    shots_needed = set()
    shots_after_needed = set()

    for lane, path in FILES:
        if not path.exists():
            print(f"WARN: missing {path}")
            continue
        text = path.read_text()
        sections = split_headings(text)
        current_group = None  # nearest preceding level-2 heading text (UX-style lane grouping)

        for order, sec in enumerate(sections):
            title_raw = sec['raw_title']
            level = sec['level']
            body = sec['body']

            if level == 2:
                current_group = title_raw

            num = None
            title = title_raw
            m = NUM_RE.match(title_raw)
            if m:
                num = m.group(1)
                title = m.group(2).strip()

            severity = None
            bm = BRACKET_RE.match(title)
            if bm:
                severity = bm.group(1).strip()
                title = bm.group(2).strip()
            elif lane == 'UX' and level == 3 and current_group and NUM_RE.match(title_raw):
                # UX-style: severity/lane comes from the enclosing ## heading
                severity = current_group.strip()

            status = extract_status(body)
            commit = extract_commit(body)
            pngs = extract_pngs(body)
            before_shots, after_shots = [], []
            for name in pngs:
                if (REVIEW / 'shots-after' / name).exists():
                    after_shots.append(name)
                    shots_after_needed.add(name)
                elif (REVIEW / 'shots' / name).exists():
                    before_shots.append(name)
                    shots_needed.add(name)

            entry_id = f"{lane.lower()}-{slugify((num or '') + '-' + title)}-{order}"
            findings.append({
                'id': entry_id,
                'lane': lane,
                'level': level,
                'number': num,
                'title': title or title_raw,
                'severity': severity,
                'status': status,
                'commit': commit,
                'before_shots': before_shots,
                'after_shots': after_shots,
                'body_md': body,
                'has_children': sec['has_children'],
                'source_file': path.name,
            })

    OUT_DATA_DIR.mkdir(parents=True, exist_ok=True)
    OUT_ASSETS_DIR.mkdir(parents=True, exist_ok=True)

    import base64
    manifest = {}
    for name in shots_needed:
        b = (REVIEW / 'shots' / name).read_bytes()
        manifest[f'shots/{name}'] = base64.b64encode(b).decode('ascii')
    for name in shots_after_needed:
        b = (REVIEW / 'shots-after' / name).read_bytes()
        manifest[f'shots-after/{name}'] = base64.b64encode(b).decode('ascii')
    (OUT_ASSETS_DIR / 'manifest.json').write_text(json.dumps(manifest))

    statuses = sorted({f['status'] for f in findings if f['status']})
    lanes = sorted({f['lane'] for f in findings})
    severities = sorted({f['severity'] for f in findings if f['severity']})

    out = {
        'generated_at': __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),
        'source_files': [p.name for _, p in FILES],
        'lanes': lanes,
        'severities': severities,
        'statuses': statuses,
        'findings': findings,
    }
    (OUT_DATA_DIR / 'findings.json').write_text(json.dumps(out, indent=2))
    print(f"wrote {len(findings)} entries, {len(shots_needed)} before-shots, {len(shots_after_needed)} after-shots")
    print(f"lanes={lanes}")
    print(f"severities={severities}")
    print(f"statuses={statuses}")
    print(f"manifest size: {(OUT_ASSETS_DIR / 'manifest.json').stat().st_size / 1024:.0f} KB")


if __name__ == '__main__':
    build()
