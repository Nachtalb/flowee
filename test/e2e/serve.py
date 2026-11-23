#!/usr/bin/env python3
"""Served-material check: the Worker in `wrangler dev` (managed mode, which also runs the [build] step that builds
served/) serves every file of its manifest equal to the repository's, the root document as markdown and HTML,
POST /validate, and `flowee.py version` / `update` work against it.

  python3 test/e2e/serve.py [--print-root]    # --print-root: print the root document as served, then the checks

Everything lives in a scratch directory removed at the end; wrangler is stopped at the end. No real remote is used.
"""
import json, os, shutil, socket, subprocess, sys, tempfile, threading, urllib.error, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
UA = {"User-Agent": "flowee-e2e"}
INSTANCE = {"flowee": 1, "workspaces": [], "instance": {"bot": {"token": "BOT_TOKEN", "webhookSecret": "BOT_HOOK", "username": "example_flowee_bot"},
                                                       "publicUrl": "https://flowee.example.workers.dev", "owner": "1"}}


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start(scratch):
    port = free_port()
    args = ["npx", "wrangler", "dev", "--ip", "127.0.0.1", "--port", str(port), "--persist-to", str(scratch / "state"),
            "--show-interactive-dev-session=false", "--var", "FLOWEE_MODE:managed", "--var", f"FLOWEE_CONFIG:{json.dumps(INSTANCE)}",
            "--var", "FLOWEE_KEY:serve-key"]
    p = subprocess.Popen(args, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=dict(os.environ, NO_COLOR="1"))
    assert p.stdout
    for line in p.stdout:
        if "Ready on" in line:
            break
    else:
        raise SystemExit("wrangler dev ended before it was ready")
    threading.Thread(target=lambda: [None for _ in p.stdout], daemon=True).start()
    return p, f"http://127.0.0.1:{port}"


def get(url, headers=None, data=None):
    req = urllib.request.Request(url, data=data, headers={**UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def main():
    scratch = Path(tempfile.mkdtemp(prefix="flowee-serve-"))
    worker, url = start(scratch)
    fails = []

    def check(what, ok):
        print(("ok   " if ok else "FAIL ") + what)
        if not ok:
            fails.append(what)

    try:
        _, _, body = get(f"{url}/manifest.json")
        m = json.loads(body)
        same = [p for p in m["files"] if (ROOT / p).is_file() and get(f"{url}/{p}")[2] == (ROOT / p).read_bytes()]
        sources = [p for p in m["files"] if (ROOT / p).is_file()]
        check(f"{len(same)} of {len(sources)} served files equal the repository's", same == sources and len(sources) > 30)
        status, h, md = get(f"{url}/")
        if "--print-root" in sys.argv:
            print(md.decode())
        check("/ is markdown for curl", status == 200 and h.get("Content-Type") == "text/markdown; charset=utf-8" and md.startswith(b"# Flowee: set it up from this URL"))
        check("/ names the managed mode and the instance bot", b"- Mode: managed\n" in md and b"- Chat bot: @example_flowee_bot\n" in md)
        check("/llms.txt is the same document", get(f"{url}/llms.txt")[2] == md)
        status, h, html = get(f"{url}/", {"Accept": "text/html"})
        check("/ is HTML for a browser", h.get("Content-Type") == "text/html; charset=utf-8" and b'<img src="/assets/logo.svg"' in html)
        check("an ETag answers 304", get(f"{url}/docs/api.md", {"If-None-Match": get(f"{url}/docs/api.md")[1].get("ETag", "")})[0] == 304)
        ws = json.loads((ROOT / "test/workspaces.json").read_text())["workspaces"][0]
        status, _, b = get(f"{url}/validate", {"Content-Type": "application/json"}, json.dumps(ws).encode())
        check("POST /validate: a valid workspace", status == 200 and json.loads(b) == {"ok": True, "kind": "workspace", "ids": [ws["id"]]})
        status, _, b = get(f"{url}/validate", {"Content-Type": "application/json"}, json.dumps({**ws, "roles": 1}).encode())
        check("POST /validate: problems with their JSON path", status == 400 and all(p.startswith("$") for p in json.loads(b)["problems"]))

        cfg = scratch / "empty.toml"
        cfg.write_text("")
        env = dict(os.environ, FLOWEE_URL=url, FLOWEE_CONFIG=str(cfg))
        r = subprocess.run([sys.executable, str(ROOT / "client/flowee.py"), "version"], env=env, capture_output=True, text=True)
        print(r.stdout.rstrip())
        check("flowee.py version: up to date with the served client", r.returncode == 0 and r.stdout.rstrip().endswith("up to date"))
        old = scratch / "flowee.py"
        old.write_text((ROOT / "client/flowee.py").read_text().replace(f'VERSION = "{m["client"]["version"]}"', 'VERSION = "0.0.1"'))
        r = subprocess.run([sys.executable, str(old), "version"], env=env, capture_output=True, text=True)
        check("an older copy is told to update", "the instance serves a newer client: update with" in r.stdout)
        r = subprocess.run([sys.executable, str(old), "update"], env=env, capture_output=True, text=True)
        print(r.stdout.rstrip())
        check("flowee.py update replaces it with the served client", r.returncode == 0 and old.read_bytes() == (ROOT / "client/flowee.py").read_bytes())
    finally:
        worker.terminate()
        worker.wait(timeout=30)
        shutil.rmtree(scratch, ignore_errors=True)
    print("serve check: " + ("passed" if not fails else f"{len(fails)} failed"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
