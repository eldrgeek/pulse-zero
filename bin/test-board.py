#!/usr/bin/env python3
"""test-board.py — automated smoke test for the Pulse Zero board.

Written 2026-07-26 after Mike found 5 real bugs on first use of a board that
shipped with ZERO test coverage. This is the "would have caught it" check:
run before any future change to public/index.html or bin/pulse-push.

What it does:
  1. Pushes a handful of test cards via bin/pulse-push (real CLI, not a
     reimplementation) — including a same-title/same-source pair to exercise
     the dedup safety net, a --key pair to exercise key-based replace, a
     decision card to check the Other-dialog contrast, and a pre-resolved
     ("done") card to check it's hidden by default.
  2. Logs into the LIVE deployed board (https://pulse-zero.netlify.app) via
     Chrome CDP (localhost:9222 — the one-and-only debug Chrome, per
     ~/Projects/CLAUDE.md "Only debug Chrome ever runs"), using an
     admin-generated magic-link token verified client-side with
     sb.auth.verifyOtp — same technique as the 2026-07-26 manual verification
     pass (see _estate/verification/2026-07-26-pulse-zero-v2.md). Opens its
     OWN new tab; never touches or closes any tab Mike already has open, and
     never calls signOut (that would invalidate Mike's real sessions).
  3. Asserts:
     - no duplicate OPEN action cards with the same title+source
     - a --key push replaces the existing OPEN card in place (same id)
     - a typed action button queues exactly one durable Mac command, receives
       a verified executor receipt, and auto-resolves its card
     - 101 terminal rows cannot crowd an OPEN card out of the board query
     - a resolved ("done") card is NOT visible on load, but appears once the
       "Recently done" disclosure is opened
     - the decision card's "Other" textresp input has non-equal computed
       background/text colors in both light and dark prefers-color-scheme
     - authenticated Pulse voice uses the signed-session broker, and the
       task-scoped Ask Pulse affordance expands and focuses its safe input
     - no mailto: link is served for feedback; a soma-feedback chip element
       is present in the DOM instead
  4. Deletes every row it created (by created_by == TEST_SOURCE) so the board
     is left exactly as it was found.

Exit 0 = all assertions passed. Exit 1 = a real regression was caught.

Requires: PULSE_ZERO_SERVICE_KEY in the environment, Chrome running with
--remote-debugging-port=9222, Python 3 stdlib + the `websocket-client`
package (already installed on this Mac; no Playwright/npm install needed).
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import urllib.parse
import uuid

import websocket  # websocket-client

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PULSE_PUSH = os.path.join(REPO, "bin", "pulse-push")
SUPABASE_URL = os.environ.get("PULSE_ZERO_SUPABASE_URL", "https://omfwcodoimjmbrhssvfl.supabase.co")
BOARD_URL = "https://pulse-zero.netlify.app"
APP_ID = "pulse-zero"
CDP_HTTP = "http://localhost:9222"
MIKE_EMAIL = "mw@mike-wolf.com"

NONCE = uuid.uuid4().hex[:8]
TEST_SOURCE = f"smoke-test-{NONCE}"

FAILURES = []
PASSES = []


def ok(name, detail=""):
    PASSES.append(name)
    print(f"  [PASS] {name}" + (f" — {detail}" if detail else ""))


def fail(name, detail=""):
    FAILURES.append((name, detail))
    print(f"  [FAIL] {name}" + (f" — {detail}" if detail else ""), file=sys.stderr)


def sb_rest(method, path, key, params=None, body=None):
    full = f"{SUPABASE_URL}/rest/v1/{path}"
    if params:
        full += "?" + "&".join(f"{k}={urllib.parse.quote(str(v), safe='')}" for k, v in params.items())
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(full, data=data, method=method)
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("Content-Type", "application/json")
    if method in ("POST", "PATCH"):
        req.add_header("Prefer", "return=representation")
    with urllib.request.urlopen(req) as resp:
        raw = resp.read().decode()
        return json.loads(raw) if raw else None


def sb_admin_generate_link(key, email, redirect_to):
    full = f"{SUPABASE_URL}/auth/v1/admin/generate_link"
    body = json.dumps({"type": "magiclink", "email": email, "options": {"redirect_to": redirect_to}}).encode()
    req = urllib.request.Request(full, data=body, method="POST")
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())


# ── CDP helpers ──────────────────────────────────────────────────────────

class CDPTab:
    def __init__(self):
        req = urllib.request.Request(f"{CDP_HTTP}/json/new?about:blank", method="PUT")
        with urllib.request.urlopen(req) as resp:
            info = json.loads(resp.read().decode())
        self.id = info["id"]
        self.ws = websocket.create_connection(info["webSocketDebuggerUrl"], timeout=30)
        self._msg_id = 0
        self.send("Page.enable")
        self.send("Runtime.enable")

    def send(self, method, params=None):
        self._msg_id += 1
        mid = self._msg_id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        while True:
            raw = self.ws.recv()
            msg = json.loads(raw)
            if msg.get("id") == mid:
                return msg.get("result", {})
            # drop unrelated events while waiting for our response

    def navigate(self, url, wait_ms=4000):
        self.send("Page.navigate", {"url": url})
        time.sleep(wait_ms / 1000)

    def eval(self, expr, await_promise=False, timeout_ms=15000):
        result = self.send("Runtime.evaluate", {
            "expression": expr,
            "returnByValue": True,
            "awaitPromise": await_promise,
        })
        if result.get("exceptionDetails"):
            raise RuntimeError(json.dumps(result["exceptionDetails"])[:500])
        return result.get("result", {}).get("value")

    def set_color_scheme(self, scheme):
        self.send("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-color-scheme", "value": scheme}]})

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass
        try:
            req = urllib.request.Request(f"{CDP_HTTP}/json/close/{self.id}")
            urllib.request.urlopen(req)
        except Exception:
            pass


def wait_for(tab, expr, timeout_s=10, interval_s=0.4):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            if tab.eval(expr):
                return True
        except RuntimeError:
            pass
        time.sleep(interval_s)
    return False


def main():
    key = os.environ.get("PULSE_ZERO_SERVICE_KEY")
    if not key:
        print("PULSE_ZERO_SERVICE_KEY not set", file=sys.stderr)
        return 1

    created_ids = []
    typed_command_id = None

    print(f"\n=== Pulse Zero board smoke test (nonce={NONCE}) ===\n")
    print("Pushing test cards via bin/pulse-push ...")

    dup_title = f"Smoke dup card {NONCE}"
    p1 = subprocess.run([PULSE_PUSH, "action", "--title", dup_title, "--url", "https://example.test",
                         "--source", TEST_SOURCE], capture_output=True, text=True,
                        env={**os.environ, "PULSE_ZERO_SERVICE_KEY": key})
    p2 = subprocess.run([PULSE_PUSH, "action", "--title", dup_title, "--url", "https://example.test",
                         "--source", TEST_SOURCE], capture_output=True, text=True,
                        env={**os.environ, "PULSE_ZERO_SERVICE_KEY": key})
    print("  push #1:", p1.stdout.strip(), p1.stderr.strip())
    print("  push #2:", p2.stdout.strip(), p2.stderr.strip())
    if p2.returncode != 0:
        fail("dedup-safety-net CLI call", f"non-zero exit: {p2.stderr}")
    elif "skipped duplicate" not in p2.stdout:
        fail("dedup-safety-net skip message", f"expected 'skipped duplicate' in stdout, got: {p2.stdout!r}")
    else:
        ok("dedup-safety-net: second identical push skipped (stdout)")

    key_slug = f"smoke-key-{NONCE}"
    old_step = f"Open old smoke page {NONCE}"
    new_step = f"Open current smoke page {NONCE}"
    step_action_label = f"Open smoke page {NONCE}"
    k1 = subprocess.run([PULSE_PUSH, "action", "--title", f"Smoke key card v1 {NONCE}",
                         "--url", "https://example.test", "--source", TEST_SOURCE, "--key", key_slug,
                         "--steps", old_step],
                        capture_output=True, text=True, env={**os.environ, "PULSE_ZERO_SERVICE_KEY": key})
    seeded = sb_rest("GET", "pulse_cards", key, params={
        "app_id": f"eq.{APP_ID}", "dedupe_key": f"eq.{key_slug}", "limit": "1",
    })
    if seeded:
        sb_rest("PATCH", "pulse_cards", key, params={"id": f"eq.{seeded[0]['id']}"},
                body={"step_state": {"0": True}})
    k2 = subprocess.run([PULSE_PUSH, "action", "--title", f"Smoke key card v2 {NONCE}",
                         "--url", "https://example.test", "--source", TEST_SOURCE, "--key", key_slug,
                         "--steps", new_step,
                         "--step-actions", json.dumps([{
                             "command": "open_url",
                             "label": step_action_label,
                             "payload": {"url": "https://example.test/current"},
                         }])],
                        capture_output=True, text=True, env={**os.environ, "PULSE_ZERO_SERVICE_KEY": key})
    print("  key push #1:", k1.stdout.strip())
    print("  key push #2:", k2.stdout.strip())

    decision_q = f"Smoke decision {NONCE}?"
    subprocess.run([PULSE_PUSH, "decision", "--question", decision_q, "--options", "A,B,Other",
                    "--source", TEST_SOURCE], capture_output=True, text=True,
                   env={**os.environ, "PULSE_ZERO_SERVICE_KEY": key})

    # ── 2026-08-14 fix-wave regression fixtures ─────────────────────────
    # Decision with more than 4 options — the board used to hard-slice to 4
    # with no on-card signal (UX finding). It must now render every option.
    many_opts_q = f"Smoke many-options decision {NONCE}?"
    subprocess.run([PULSE_PUSH, "decision", "--question", many_opts_q,
                    "--options", "Alpha,Beta,Gamma,Delta,Epsilon,Zeta",
                    "--source", TEST_SOURCE], capture_output=True, text=True,
                   env={**os.environ, "PULSE_ZERO_SERVICE_KEY": key})

    # Hostile body text — markdown + a raw HTML payload + a bare URL, all in
    # one --why. Must render bold/em/code and an auto-link, but the raw
    # <img onerror> must never become a live element (UX#4/UX#2 + CODE#4
    # composition — the auto-linkifier also runs safeHttpUrl()).
    hostile_title = f"Smoke hostile body {NONCE}"
    long_url = "https://example.test/" + ("a" * 90) + "/tail"
    hostile_why = (
        f"**bold** and _em_ and `code`, a link {long_url} mid-sentence, "
        f'and a raw payload <img src=x onerror=alert(1)> plus a bad scheme '
        f'[click](javascript:alert(2)) as PLAIN TEXT (not authored as payload.url).'
    )
    subprocess.run([PULSE_PUSH, "action", "--title", hostile_title, "--url", "https://example.test",
                    "--why", hostile_why, "--source", TEST_SOURCE],
                   capture_output=True, text=True, env={**os.environ, "PULSE_ZERO_SERVICE_KEY": key})

    # Comment-thread card for the draft-preservation check (CODE#9).
    draft_title = f"Smoke draft-preservation card {NONCE}"
    subprocess.run([PULSE_PUSH, "action", "--title", draft_title, "--url", "https://example.test",
                    "--source", TEST_SOURCE], capture_output=True, text=True,
                   env={**os.environ, "PULSE_ZERO_SERVICE_KEY": key})

    typed_title = f"Smoke typed action {NONCE}"
    typed_label = f"Verify bridge {NONCE}"
    typed_action_id = f"gdoc-auth-{NONCE}"
    typed_actions = [{
        "id": typed_action_id,
        "revision": 1,
        "executor": "workflow",
        "label": typed_label,
        "description": "Exercise the deployed typed-action path with a read-only Drive verification.",
        "operation": "gdoc_bridge_authorize",
        "params": {
            "project_id": "gdoc-bridge-mw",
            "account": MIKE_EMAIL,
        },
        "human_gate": {
            "instruction": "Click the highlighted Continue or Allow button.",
            "target": {
                "url": "https://accounts.google.com/o/oauth2/v2/auth",
                "ref": "google.oauth.consent.primary",
                "label": "Continue or Allow",
            },
        },
        "completion": {
            "mode": "verified",
            "success_message": "Typed-action smoke verification passed.",
            "close_card": True,
        },
        "verification": {
            "kind": "google_drive_about",
            "params": {},
        },
    }]
    typed_push = subprocess.run([
        PULSE_PUSH, "action",
        "--title", typed_title,
        "--why", "Production smoke test of the complete typed-action transport.",
        "--steps", "Clicking the action must produce a verified receipt and close this card.",
        "--actions", json.dumps(typed_actions),
        "--source", TEST_SOURCE,
        "--key", f"smoke-typed-{NONCE}",
    ], capture_output=True, text=True, env={**os.environ, "PULSE_ZERO_SERVICE_KEY": key})
    if typed_push.returncode == 0:
        ok("typed action fixture accepted by pulse-push")
    else:
        fail("typed action fixture accepted by pulse-push", typed_push.stderr.strip())

    done_title = f"Smoke done card {NONCE}"
    d1 = subprocess.run([PULSE_PUSH, "action", "--title", done_title, "--url", "https://example.test",
                         "--source", TEST_SOURCE], capture_output=True, text=True,
                        env={**os.environ, "PULSE_ZERO_SERVICE_KEY": key})
    try:
        done_id = d1.stdout.strip().rsplit(" ", 1)[1]
    except Exception:
        done_id = None
    if done_id:
        subprocess.run([PULSE_PUSH, "resolve", "--id", done_id, "--note", "smoke test — pre-marked done"],
                        capture_output=True, text=True, env={**os.environ, "PULSE_ZERO_SERVICE_KEY": key})

    # Regression fixture for the old all-status ORDER/LIMIT query: answered
    # sorts before open, so 101 terminal rows used to make every active card
    # disappear. Ancient timestamps keep these rows out of the bounded
    # "Recently done" slice in the corrected two-query implementation.
    history_noise = [{
        "app_id": APP_ID,
        "type": "brief",
        "payload": {"title": f"Smoke history noise {NONCE} #{i}", "lines": "terminal fixture"},
        "status": "answered",
        "answer": {"action_id": "ack", "value": "ack"},
        "created_by": TEST_SOURCE,
        "created_at": f"2020-01-01T00:{i // 60:02d}:{i % 60:02d}Z",
        "answered_at": f"2020-01-01T00:{i // 60:02d}:{i % 60:02d}Z",
    } for i in range(101)]
    sb_rest("POST", "pulse_cards", key, body=history_noise)

    # ── DB-level assertions (ground truth, independent of DOM rendering) ──
    print("\nDB-level assertions ...")
    rows = sb_rest("GET", "pulse_cards", key, params={
        "app_id": f"eq.{APP_ID}", "created_by": f"eq.{TEST_SOURCE}", "order": "created_at.asc",
    })
    created_ids = [r["id"] for r in rows]
    open_dup_rows = [r for r in rows if r["status"] == "open" and (r.get("payload") or {}).get("title") == dup_title]
    if len(open_dup_rows) == 1:
        ok("no duplicate OPEN cards with same title+source", f"1 row for {dup_title!r}")
    else:
        fail("no duplicate OPEN cards with same title+source", f"found {len(open_dup_rows)} open rows for {dup_title!r}")

    key_rows = [r for r in rows if r.get("dedupe_key") == key_slug]
    if len(key_rows) == 1 and key_rows[0]["payload"]["title"] == f"Smoke key card v2 {NONCE}":
        ok("--key push replaces existing OPEN card in place", f"1 row, title updated to v2, id={key_rows[0]['id']}")
    else:
        fail("--key push replaces existing OPEN card in place", f"found {len(key_rows)} rows: {[r.get('payload',{}).get('title') for r in key_rows]}")
    if len(key_rows) == 1 and key_rows[0].get("step_state") == {}:
        ok("changed step text clears stale index-aligned checkmarks")
    else:
        fail("changed step text clears stale index-aligned checkmarks",
             f"step_state={key_rows[0].get('step_state') if key_rows else None}")

    # CODE#2 (2026-08-14): the DB-level partial unique index on
    # (dedupe_key) WHERE status='open' must refuse a second OPEN row with a
    # dedupe_key that's already open — bypass pulse-push's own app-level
    # lookup+PATCH by POSTing directly, mirroring what a raw writer
    # (pulse_common.push_card, which does no pre-lookup at all) would do.
    dup_key_slug = f"smoke-dupkey-{NONCE}"
    sb_rest("POST", "pulse_cards", key, body={
        "app_id": APP_ID, "type": "action", "status": "open", "dedupe_key": dup_key_slug,
        "payload": {"title": f"Smoke dupkey A {NONCE}", "url": "https://example.test"},
        "created_by": TEST_SOURCE,
    })
    dup_key_rejected = False
    try:
        sb_rest("POST", "pulse_cards", key, body={
            "app_id": APP_ID, "type": "action", "status": "open", "dedupe_key": dup_key_slug,
            "payload": {"title": f"Smoke dupkey B {NONCE}", "url": "https://example.test"},
            "created_by": TEST_SOURCE,
        })
    except urllib.error.HTTPError as e:
        dup_key_rejected = e.code == 409
    if dup_key_rejected:
        ok("DB rejects a second OPEN row with the same dedupe_key (unique index)")
    else:
        fail("DB rejects a second OPEN row with the same dedupe_key (unique index)",
             "second insert did not raise 409 — the partial unique index is missing or not enforced")

    # CODE#1/#12/#13 (2026-08-14): verdict card titles must never render '?'.
    # Push a real open verdict and confirm every title-deriving tool in the
    # estate (pulse-answer-write --list is the one the task brief named)
    # reads artifact_name, not the nonexistent 'artifact' key.
    verdict_artifact = f"Smoke verdict artifact {NONCE}"
    subprocess.run([PULSE_PUSH, "verdict", "--artifact", verdict_artifact,
                    "--url", "https://example.test", "--summary", "Smoke verdict summary",
                    "--source", TEST_SOURCE], capture_output=True, text=True,
                   env={**os.environ, "PULSE_ZERO_SERVICE_KEY": key})
    paw_list = subprocess.run(
        [os.path.expanduser("~/Projects/_estate/bin/pulse-answer-write"), "--list"],
        capture_output=True, text=True,
    )
    matching_line = next((line for line in paw_list.stdout.splitlines() if verdict_artifact in line), None)
    if matching_line:
        ok("pulse-answer-write --list shows the verdict's real title, not '?'", matching_line.strip())
    else:
        fail("pulse-answer-write --list shows the verdict's real title, not '?'",
             f"no line contained {verdict_artifact!r}; stdout={paw_list.stdout[:500]!r}")

    done_rows = [r for r in rows if r.get("payload", {}).get("title") == done_title]
    if done_rows and done_rows[0]["status"] == "resolved":
        ok("pre-marked card is status=resolved in DB")
    else:
        fail("pre-marked card is status=resolved in DB", f"rows: {done_rows}")

    # ── Browser-level assertions ───────────────────────────────────────
    print("\nBrowser assertions (CDP, new tab, localhost:9222) ...")
    tab = None
    try:
        gen = sb_admin_generate_link(key, MIKE_EMAIL, BOARD_URL)
        token_hash = gen.get("hashed_token") or (gen.get("properties") or {}).get("hashed_token")
        if not token_hash:
            fail("admin generate_link", f"no hashed_token in response: {json.dumps(gen)[:300]}")
            raise SystemExit
        ok("admin-generated magic-link token", f"hashed_token len={len(token_hash)}")

        tab = CDPTab()
        tab.send("Page.addScriptToEvaluateOnNewDocument", {"source": """
            window.__pulseSmokeErrors = [];
            window.addEventListener('error', event => {
                window.__pulseSmokeErrors.push(String(event.error || event.message || 'error'));
            });
            window.addEventListener('unhandledrejection', event => {
                window.__pulseSmokeErrors.push(String(event.reason || 'unhandled rejection'));
            });
        """})
        tab.navigate(BOARD_URL, wait_ms=2500)
        logged_in = tab.eval(
            f"""(async () => {{
                const {{ data, error }} = await sb.auth.verifyOtp({{ token_hash: {json.dumps(token_hash)}, type: 'magiclink' }});
                return !!(data && data.session) && !error;
            }})()""",
            await_promise=True,
        )
        if not logged_in:
            fail("verifyOtp login", "session not established")
            raise SystemExit
        ok("logged in via admin-generated token (verifyOtp)")

        tab.navigate(BOARD_URL, wait_ms=3000)
        wait_for(tab, "!!document.getElementById('cards')", timeout_s=8)
        active_survived = wait_for(
            tab,
            f"document.body.innerText.includes({json.dumps(dup_title)})",
            timeout_s=20,
        )
        if active_survived:
            ok("open card remains visible with 101 terminal rows")
        else:
            board_state = tab.eval("""({
                cards: document.getElementById('cards')?.innerText || '',
                count: document.getElementById('count')?.innerText || '',
                errors: window.__pulseSmokeErrors || [],
            })""")
            fail("open card remains visible with 101 terminal rows", str(board_state))

        wait_for(
            tab,
            f"""[...document.querySelectorAll('button[data-typed-action]')]
                .some(candidate => candidate.textContent.trim() === {json.dumps(typed_label)})""",
            timeout_s=20,
        )
        typed_button_state = tab.eval(
            f"""(() => {{
                const button = [...document.querySelectorAll('button[data-typed-action]')]
                    .find(candidate => candidate.textContent.trim() === {json.dumps(typed_label)});
                if (!button) return null;
                const card = button.closest('.card');
                const state = {{
                    tag: button.tagName,
                    disabled: button.disabled,
                    actionId: button.dataset.typedAction,
                    cardText: card && card.innerText,
                }};
                if (!button.disabled) button.click();
                return state;
            }})()"""
        )
        if (typed_button_state and
                typed_button_state["tag"] == "BUTTON" and
                not typed_button_state["disabled"] and
                typed_button_state["actionId"] == typed_action_id):
            ok("typed action renders as an enabled clickable button")
        else:
            fail("typed action renders as an enabled clickable button", str(typed_button_state))

        typed_card_rows = [r for r in rows if (r.get("payload") or {}).get("title") == typed_title]
        typed_card_id = typed_card_rows[0]["id"] if typed_card_rows else None
        typed_run = None
        if typed_card_id and typed_button_state:
            deadline = time.time() + 20
            while time.time() < deadline:
                runs = sb_rest("GET", "mac_commands", key, params={
                    "pulse_card_id": f"eq.{typed_card_id}",
                    "pulse_action_id": f"eq.{typed_action_id}",
                    "order": "attempt.desc",
                    "limit": "1",
                })
                if runs:
                    typed_run = runs[0]
                    typed_command_id = typed_run["id"]
                    if typed_run.get("status") in ("done", "failed"):
                        break
                time.sleep(0.5)
        if (typed_run and typed_run.get("status") == "done" and
                (typed_run.get("result") or {}).get("verified") is True and
                (typed_run.get("result") or {}).get("state") == "done"):
            ok("typed action receives a verified executor receipt")
        else:
            fail("typed action receives a verified executor receipt", str(typed_run))

        resolved_typed = []
        if typed_card_id:
            deadline = time.time() + 10
            while time.time() < deadline:
                resolved_typed = sb_rest("GET", "pulse_cards", key, params={
                    "id": f"eq.{typed_card_id}",
                    "select": "id,status,resolved_note",
                })
                if resolved_typed and resolved_typed[0].get("status") == "resolved":
                    break
                time.sleep(0.5)
        if resolved_typed and resolved_typed[0].get("status") == "resolved":
            ok("verified typed action auto-resolves its card")
        else:
            fail("verified typed action auto-resolves its card", str(resolved_typed))

        wait_for(
            tab,
            f"""[...document.querySelectorAll('.step-action-btn')]
                .some(button => button.textContent.trim() === {json.dumps(step_action_label)})""",
            timeout_s=10,
        )
        step_action_state = tab.eval(
            f"""(() => {{
                const action = [...document.querySelectorAll('.step-action-btn')]
                    .find(b => b.textContent.trim() === {json.dumps(step_action_label)});
                return action && {{
                    tag: action.tagName,
                    href: action.href,
                    target: action.target,
                    rel: action.rel,
                }};
            }})()"""
        )
        if (step_action_state and
                step_action_state["tag"] == "A" and
                step_action_state["href"] == "https://example.test/current" and
                step_action_state["target"] == "_blank" and
                "noopener" in step_action_state["rel"]):
            ok("open_url renders as a native safe link", str(step_action_state))
        else:
            fail("open_url renders as a native safe link", str(step_action_state))

        secret_guard = tab.eval("""({
            gemini: looksLikeSecret('AIza' + 'A'.repeat(35)),
            appPassword: looksLikeSecret('abcd efgh ijkl mnop'),
            normalComment: looksLikeSecret('Please explain why the service check failed.'),
        })""")
        if secret_guard == {"gemini": True, "appPassword": True, "normalComment": False}:
            ok("Ask Pulse blocks obvious credentials without blocking normal comments")
        else:
            fail("Ask Pulse blocks obvious credentials without blocking normal comments", str(secret_guard))

        pulse_controls = tab.eval("""(async () => {
            const bar = document.getElementById('talk-bar');
            const { data: { session } } = await sb.auth.getSession();
            const signed = await fetch('/.netlify/functions/pulse-agent-session', {
                headers: { Authorization: `Bearer ${session.access_token}` },
                cache: 'no-store',
            });
            const signedBody = await signed.json().catch(() => ({}));
            // Resolve the action-receipt fetch first; a realtime render during
            // that await must not be mistaken for broken synchronous focus.
            const ask = [...document.querySelectorAll('button')]
                .find(b => b.textContent.trim() === 'Ask Pulse');
            const askCard = ask && ask.closest('.card');
            if (ask) ask.click();
            const input = askCard && askCard.querySelector('.comment-input');
            return {
                barVisible: !!bar && !bar.hidden,
                askPresent: !!ask,
                inputFocused: document.activeElement === input,
                safePlaceholder: !!input && input.placeholder.includes('never paste credentials'),
                signedStatus: signed.status,
                signedShape: typeof signedBody.signed_url === 'string' &&
                    signedBody.signed_url.startsWith('wss://'),
            };
        })()""", await_promise=True)
        if pulse_controls["barVisible"]:
            ok("voice control visible after Pulse authentication")
        else:
            fail("voice control visible after Pulse authentication")
        if pulse_controls["askPresent"] and pulse_controls["inputFocused"] and pulse_controls["safePlaceholder"]:
            ok("Ask Pulse opens and focuses the task-scoped safe input")
        else:
            fail("Ask Pulse opens and focuses the task-scoped safe input", str(pulse_controls))
        if pulse_controls["signedStatus"] == 200 and pulse_controls["signedShape"]:
            ok("authenticated signed-session broker returns a WebSocket URL")
        else:
            fail("authenticated signed-session broker returns a WebSocket URL", str(pulse_controls))

        realtime_errors = tab.eval(
            "window.__pulseSmokeErrors.filter(e => e.includes('cannot add `postgres_changes` callbacks'))"
        )
        if not realtime_errors:
            ok("realtime subscription initializes once without callback errors")
        else:
            fail("realtime subscription initializes once without callback errors", str(realtime_errors))

        # done card hidden by default, revealed by disclosure
        hidden_before = tab.eval(f"!document.getElementById('cards').innerText.includes({json.dumps(done_title)})")
        if hidden_before:
            ok("done card NOT visible before expanding 'Recently done'")
        else:
            fail("done card NOT visible before expanding 'Recently done'", "title text found in main#cards before expand")

        wait_for(
            tab,
            """[...document.querySelectorAll('details.bounced-section')]
                .some(x => x.querySelector('summary')?.textContent.includes('Recently done'))""",
            timeout_s=10,
        )
        opened = tab.eval("""(() => {
            const d = [...document.querySelectorAll('details.bounced-section')]
                .find(x => x.querySelector('summary') && x.querySelector('summary').textContent.includes('Recently done'));
            if (!d) return false;
            d.open = true;
            return true;
        })()""")
        if opened:
            visible_after = tab.eval(f"document.getElementById('cards').innerText.includes({json.dumps(done_title)})")
            if visible_after:
                ok("done card visible after expanding 'Recently done'")
            else:
                fail("done card visible after expanding 'Recently done'", "still not found after open=true")
        else:
            fail("'Recently done' disclosure present", "no details.bounced-section with that summary text found")

        # ── 2026-08-14 fix-wave regressions (top findings, each lane) ────
        # Real device geometry, matching the live UX review's own method.
        tab.send("Emulation.setDeviceMetricsOverride", {
            "width": 412, "height": 915, "deviceScaleFactor": 3, "mobile": True,
        })
        tab.navigate(BOARD_URL, wait_ms=2500)
        wait_for(tab, f"document.body.innerText.includes({json.dumps(many_opts_q)})", timeout_s=10)

        # UX finding: decision options used to hard-slice to 4, no on-card signal.
        opt_state = tab.eval(f"""(() => {{
            const card = [...document.querySelectorAll('.card')]
                .find(c => c.textContent.includes({json.dumps(many_opts_q)}));
            if (!card) return null;
            return [...card.querySelectorAll('button[data-action="opt"]')].map(b => b.textContent.trim());
        }})()""")
        if opt_state and set(opt_state) == {"Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"}:
            ok("decision card renders all 6 options, no silent truncation", str(opt_state))
        else:
            fail("decision card renders all 6 options, no silent truncation", str(opt_state))

        # CODE#4/UX#4/UX#2: hostile body text — markdown renders, raw HTML/
        # javascript: never becomes live, long URL auto-links and never
        # overflows the viewport.
        hostile_state = tab.eval(f"""(() => {{
            const card = [...document.querySelectorAll('.card')]
                .find(c => c.textContent.includes({json.dumps(hostile_title)}));
            if (!card) return null;
            const why = card.querySelector('.why');
            return {{
                hasStrong: !!why.querySelector('strong') && why.querySelector('strong').textContent === 'bold',
                hasEm: !!why.querySelector('em') && why.querySelector('em').textContent === 'em',
                hasCode: !!why.querySelector('code') && why.querySelector('code').textContent === 'code',
                autoLinked: !!why.querySelector('a[href^="https://example.test/aaa"]'),
                noRawImg: !document.querySelector('img[src="x"]'),
                noJsHref: ![...document.querySelectorAll('a[href]')].some(a => a.href.startsWith('javascript:')),
                scrollWidth: document.documentElement.scrollWidth,
                clientWidth: document.documentElement.clientWidth,
            }};
        }})()""")
        if hostile_state and hostile_state["hasStrong"] and hostile_state["hasEm"] and hostile_state["hasCode"]:
            ok("hostile body: markdown (bold/em/code) renders as real elements", str(hostile_state))
        else:
            fail("hostile body: markdown (bold/em/code) renders as real elements", str(hostile_state))
        if hostile_state and hostile_state["autoLinked"]:
            ok("hostile body: bare long URL auto-links via safeHttpUrl()")
        else:
            fail("hostile body: bare long URL auto-links via safeHttpUrl()", str(hostile_state))
        if hostile_state and hostile_state["noRawImg"] and hostile_state["noJsHref"]:
            ok("hostile body: raw <img onerror> and javascript: href never become live markup")
        else:
            fail("hostile body: raw <img onerror> and javascript: href never become live markup", str(hostile_state))
        if hostile_state and hostile_state["scrollWidth"] <= hostile_state["clientWidth"] + 2:
            ok("hostile body: long unbroken URL does not widen the page", str(hostile_state))
        else:
            fail("hostile body: long unbroken URL does not widen the page", str(hostile_state))

        # UX#5: touch-target floor on every visible primary/secondary button
        # and the comment-toggle link.
        touch_state = tab.eval("""(() => {
            const els = [...document.querySelectorAll(
                '.card:not(.answered) .btn-primary, .card:not(.answered) .btn-secondary, ' +
                '.card:not(.answered) .btn-destructive, .card:not(.answered) .comment-toggle'
            )];
            const under = els.filter(el => el.getBoundingClientRect().height < 44)
                .map(el => ({ text: el.textContent.trim().slice(0, 30), h: el.getBoundingClientRect().height }));
            return { total: els.length, under };
        })()""")
        if touch_state and touch_state["total"] > 0 and not touch_state["under"]:
            ok(f"touch targets >= 44px on all {touch_state['total']} visible card buttons/comment-toggle")
        else:
            fail("touch targets >= 44px on all visible card buttons/comment-toggle", str(touch_state))

        # UX#1: feedback chip must not overlap any visible card's action row.
        overlap_state = tab.eval("""(() => {
            const chip = document.querySelector('.soma-feedback-root');
            if (!chip) return null;
            const c = chip.getBoundingClientRect();
            const buttons = [...document.querySelectorAll('.card:not(.answered) .actions button')];
            const hit = buttons.find(b => {
                const r = b.getBoundingClientRect();
                if (r.width === 0 && r.height === 0) return false; // not in viewport / not laid out
                return !(r.right < c.left || r.left > c.right || r.bottom < c.top || r.top > c.bottom);
            });
            return {
                chip: { x: c.left, y: c.top, w: c.width, h: c.height },
                overlapsButton: hit ? hit.textContent.trim() : null,
            };
        })()""")
        if overlap_state and not overlap_state["overlapsButton"]:
            ok("feedback chip does not overlap any visible card action button", str(overlap_state["chip"]))
        else:
            fail("feedback chip does not overlap any visible card action button", str(overlap_state))

        # CODE#9: an in-progress comment draft must survive a realtime-style
        # full re-render (loadCards()), not just persist because nothing
        # happened to touch the DOM.
        draft_state = tab.eval(f"""(async () => {{
            const card = [...document.querySelectorAll('.card')]
                .find(c => c.textContent.includes({json.dumps(draft_title)}));
            if (!card) return {{ error: 'card not found' }};
            const toggle = card.querySelector('[data-action="toggle-comments"]');
            toggle.click();
            const input = card.querySelector('.comment-input');
            input.value = 'typing an unsent reply — must survive a reload';
            input.dispatchEvent(new Event('input'));
            await loadCards();  // simulates the realtime subscription's full rebuild
            const newCard = [...document.querySelectorAll('.card')]
                .find(c => c.textContent.includes({json.dumps(draft_title)}));
            const newInput = newCard && newCard.querySelector('.comment-input');
            return {{ preserved: !!newInput && newInput.value === 'typing an unsent reply — must survive a reload' }};
        }})()""", await_promise=True)
        if draft_state and draft_state.get("preserved"):
            ok("in-progress comment draft survives a realtime full re-render")
        else:
            fail("in-progress comment draft survives a realtime full re-render", str(draft_state))

        tab.send("Emulation.clearDeviceMetricsOverride")

        # Other-dialog contrast, both color schemes
        for scheme in ("dark", "light"):
            tab.set_color_scheme(scheme)
            tab.navigate(BOARD_URL, wait_ms=2500)
            wait_for(tab, f"document.body.innerText.includes({json.dumps(decision_q)})", timeout_s=8)
            clicked = tab.eval(f"""(() => {{
                const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes({json.dumps(decision_q)}));
                if (!card) return false;
                const btn = [...card.querySelectorAll('button')].find(b => b.textContent.trim() === 'Other');
                if (!btn) return false;
                btn.click();
                return true;
            }})()""")
            if not clicked:
                fail(f"Other button found+clicked ({scheme})", "decision card or Other button not found")
                continue
            colors = tab.eval("""(() => {
                const input = document.querySelector('input.textresp');
                if (!input) return null;
                const cs = getComputedStyle(input);
                return { bg: cs.backgroundColor, color: cs.color };
            })()""")
            if not colors:
                fail(f"Other-dialog input present ({scheme})", "input.textresp not found after click")
            elif colors["bg"] == colors["color"]:
                fail(f"Other-dialog contrast ({scheme})", f"background == color: {colors}")
            else:
                ok(f"Other-dialog contrast ({scheme})", f"bg={colors['bg']} color={colors['color']}")
        tab.set_color_scheme("dark")

        # feedback chip: no mailto, chip present
        tab.navigate(BOARD_URL, wait_ms=2500)
        wait_for(tab, "!!document.querySelector('.soma-feedback-root')", timeout_s=8)
        feedback_state = tab.eval("""(() => ({
            hasMailto: !!document.querySelector('a[href^="mailto:"]'),
            hasChip: !!document.querySelector('.soma-feedback-root'),
        }))()""")
        if feedback_state["hasMailto"]:
            fail("feedback chip is not a mailto link", "found a[href^=mailto:] on the page")
        else:
            ok("feedback chip is not a mailto link", "no mailto: link found")
        if feedback_state["hasChip"]:
            ok("soma-feedback chip present in DOM")
        else:
            fail("soma-feedback chip present in DOM", ".soma-feedback-root not found")

    except SystemExit:
        pass
    finally:
        if tab:
            tab.close()

        # ── Cleanup: delete every row this run created ──────────────────
        print("\nCleaning up test cards ...")
        try:
            if typed_command_id is not None:
                sb_rest("DELETE", "mac_commands", key, params={"id": f"eq.{typed_command_id}"})
            sb_rest("DELETE", "pulse_cards", key, params={"app_id": f"eq.{APP_ID}", "created_by": f"eq.{TEST_SOURCE}"})
            remaining = sb_rest("GET", "pulse_cards", key, params={"app_id": f"eq.{APP_ID}", "created_by": f"eq.{TEST_SOURCE}"})
            if not remaining:
                ok("cleanup: all test rows deleted", f"created_by={TEST_SOURCE}")
            else:
                fail("cleanup: all test rows deleted", f"{len(remaining)} rows remain")
        except Exception as e:
            fail("cleanup", str(e))

    print(f"\n=== {len(PASSES)} passed, {len(FAILURES)} failed ===")
    if FAILURES:
        print("\nFAILED:")
        for name, detail in FAILURES:
            print(f"  - {name}: {detail}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
