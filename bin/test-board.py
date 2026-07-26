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
     - a resolved ("done") card is NOT visible on load, but appears once the
       "Recently done" disclosure is opened
     - the decision card's "Other" textresp input has non-equal computed
       background/text colors in both light and dark prefers-color-scheme
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
    k1 = subprocess.run([PULSE_PUSH, "action", "--title", f"Smoke key card v1 {NONCE}",
                         "--url", "https://example.test", "--source", TEST_SOURCE, "--key", key_slug],
                        capture_output=True, text=True, env={**os.environ, "PULSE_ZERO_SERVICE_KEY": key})
    k2 = subprocess.run([PULSE_PUSH, "action", "--title", f"Smoke key card v2 {NONCE}",
                         "--url", "https://example.test", "--source", TEST_SOURCE, "--key", key_slug],
                        capture_output=True, text=True, env={**os.environ, "PULSE_ZERO_SERVICE_KEY": key})
    print("  key push #1:", k1.stdout.strip())
    print("  key push #2:", k2.stdout.strip())

    decision_q = f"Smoke decision {NONCE}?"
    subprocess.run([PULSE_PUSH, "decision", "--question", decision_q, "--options", "A,B,Other",
                    "--source", TEST_SOURCE], capture_output=True, text=True,
                   env={**os.environ, "PULSE_ZERO_SERVICE_KEY": key})

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
        wait_for(tab, f"document.body.innerText.includes({json.dumps(dup_title)})", timeout_s=8)

        # done card hidden by default, revealed by disclosure
        hidden_before = tab.eval(f"!document.getElementById('cards').innerText.includes({json.dumps(done_title)})")
        if hidden_before:
            ok("done card NOT visible before expanding 'Recently done'")
        else:
            fail("done card NOT visible before expanding 'Recently done'", "title text found in main#cards before expand")

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
