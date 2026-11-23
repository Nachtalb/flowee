#!/usr/bin/env python3
"""Wire check: a ticket's whole walk through real clients against the Worker in `wrangler dev`.

Starts a stand-in GitHub (stdlib HTTP, in memory) and `wrangler dev` with two trunk workspaces whose tracker API
is that stand-in, then walks a ticket from filing to closed with each client given:

  python3 test/e2e/wire.py [--flow-py PATH]

`client/flowee.py` always runs (workspace w2, URL /w/w2). `--flow-py` adds livedu's scripts/flow.py, unchanged
(workspace w1, plain /v1 paths resolved by its token): the proof that the API stays wire-compatible with it.
Everything lives in a scratch directory that is removed at the end; wrangler is stopped at the end.
"""
import argparse, hashlib, json, os, re, shutil, socket, subprocess, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WHO = ["board", "dev1", "dev2", "tester", "owner"]
ROLE = {"board": "board", "dev1": "developer", "dev2": "developer", "tester": "tester", "owner": "owner"}


class GitHub:
    """Issues, comments, commits on main and compare for one repo per path prefix."""

    def __init__(self):
        self.repos = {}
        me = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def go(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                status, body = me.handle(self.command, self.path, json.loads(raw) if raw else {})
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PATCH = go

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_port}"

    def repo(self, name):
        return self.repos.setdefault(name, {"issues": {}, "main": [], "comments": 0})

    def handle(self, method, path, body):
        url, _, query = path.partition("?")
        q = dict(x.split("=", 1) for x in query.split("&") if "=" in x)
        m = re.match(r"^/repos/([^/]+/[^/]+)(/.*)$", url)
        if not m:
            return 501, {"message": f"no route {method} {path}"}
        r, rest = self.repo(m.group(1)), m.group(2)
        view = lambda i: {k: v for k, v in i.items() if k != "comments"}
        page = int(q.get("page", 1))
        if rest == "/issues" and method == "GET":
            return 200, [view(i) for i in r["issues"].values() if i["state"] == q.get("state")] if page == 1 else []
        if rest == "/issues" and method == "POST":
            n = len(r["issues"]) + 1
            r["issues"][n] = {"number": n, "title": body["title"], "body": body["body"], "state": "open", "state_reason": None,
                              "labels": [{"name": x} for x in body.get("labels", [])], "assignees": [], "created_at": "2026-11-01T00:00:00Z",
                              "updated_at": "2026-11-02T00:00:00Z", "html_url": f"https://github.test/{m.group(1)}/issues/{n}", "node_id": f"I_{n}", "comments": []}
            return 201, view(r["issues"][n])
        if mm := re.match(r"^/issues/(\d+)$", rest):
            i = r["issues"].get(int(mm.group(1)))
            if not i:
                return 404, {"message": "Not Found"}
            if method == "PATCH":
                if "labels" in body:
                    i["labels"] = [{"name": x} for x in body["labels"]]
                if "assignees" in body:
                    i["assignees"] = [{"login": x} for x in body["assignees"]]
                for k in ("title", "body", "state", "state_reason"):
                    if k in body:
                        i[k] = body[k]
            return 200, view(i)
        if mm := re.match(r"^/issues/(\d+)/comments$", rest):
            i = r["issues"][int(mm.group(1))]
            if method == "POST":
                r["comments"] += 1
                i["comments"].append({"id": r["comments"], "body": body["body"]})
                return 201, i["comments"][-1]
            return 200, i["comments"] if page == 1 else []
        if rest == "/commits":
            return 200, [{"sha": s, "commit": {"message": msg}} for s, msg in reversed(r["main"])] if page == 1 else []
        if mm := re.match(r"^/compare/(\w+)\.\.\.(\w+)$", rest):
            idx = lambda s: len(r["main"]) - 1 if s == "main" else next((k for k, (x, _) in enumerate(r["main"]) if x == s), -1)
            a, b = idx(mm.group(1)), idx(mm.group(2))
            if a < 0 or b < 0:
                return 404, {"message": "Not Found"}
            return 200, {"status": "identical" if a == b else "ahead" if a < b else "behind"}
        return 501, {"message": f"no route {method} {path}"}


def workspace(id, heading, gh):
    return {"flowee": 1, "id": id, "flow": {"preset": "trunk"},
            "tracker": {"type": "github", "repos": [f"acme/{id}"], "api": gh.url, "token": "GITHUB_TOKEN"},
            "roles": [{"instance": w, "role": ROLE[w], "secret": f"{id.upper()}_{w.upper()}"} for w in WHO],
            "owners": [{"name": "Owner", "tracker": "owner"}], "texts": {"cardHeading": heading}}


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_worker(scratch, gh, heading1):
    port = free_port()
    config = {"flowee": 1, "workspaces": [workspace("w1", heading1, gh), workspace("w2", "For the owner", gh)]}
    args = ["npx", "wrangler", "dev", "--ip", "127.0.0.1", "--port", str(port), "--persist-to", str(scratch / "state"),
            "--show-interactive-dev-session=false", "--var", f"FLOWEE_CONFIG:{json.dumps(config)}", "--var", "GITHUB_TOKEN:gh-test"]
    for ws in ("w1", "w2"):
        for w in WHO:
            args += ["--var", f"{ws.upper()}_{w.upper()}:{hashlib.sha256(f'{ws}-{w}'.encode()).hexdigest()}"]
    p = subprocess.Popen(args, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=dict(os.environ, NO_COLOR="1"))
    for line in p.stdout:
        if "Ready on" in line:
            break
    else:
        raise SystemExit("wrangler dev ended before it was ready")
    threading.Thread(target=lambda: [None for _ in p.stdout], daemon=True).start()
    return p, f"http://127.0.0.1:{port}"


class Client:
    def __init__(self, name, argv, env, gates_name, repo):
        self.name, self.argv, self.env, self.gates_name, self.repo = name, argv, env, gates_name, repo

    def __call__(self, who, *args, stdin=""):
        env = dict(os.environ, **self.env(who))
        r = subprocess.run([*self.argv, *args], cwd=self.repo, env=env, input=stdin, capture_output=True, text=True)
        out = r.stdout.strip()
        try:
            out = json.loads(out)
        except ValueError:
            pass
        return r.returncode, out, r.stderr.strip()

    def green(self):
        g = lambda *a: subprocess.run(["git", *a], cwd=self.repo, capture_output=True, text=True, check=True).stdout.strip()
        (Path(self.repo) / g("rev-parse", "--git-path", self.gates_name)).write_text(json.dumps({"sha": g("rev-parse", "HEAD"), "ok": True, "clean": True, "tree": ""}))


def walk(c, gh, repo_name, heading):
    card = f"Looks right.\n\n### {heading}\nKind: test\nChanged: rename works with F2\nCheck:\n- press F2 on a file"
    spec = "## What\nx\n\n## Acceptance\n- it works"
    steps = []

    def step(expect_rc, who, *args, stdin="", want=None):
        rc, out, err = c(who, *args, stdin=stdin)
        try:
            ok = rc == expect_rc and (want is None or bool(want(out, err)))
        except (KeyError, TypeError):
            ok = False
        steps.append(ok)
        print(f"  {'ok  ' if ok else 'FAIL'} {who:6} {' '.join(args):28} rc={rc} {json.dumps(out) if not isinstance(out, str) else out} {err}")

    step(0, "board", "file", "Rename", "with", "F2", stdin=spec, want=lambda o, e: o["n"] == 1)
    step(0, "board", "next", want=lambda o, e: o["ticket"]["n"] == 1)
    step(0, "board", "triage", "1", stdin="specified", want=lambda o, e: o["state"] == "ready")
    step(0, "dev1", "next", want=lambda o, e: o["ticket"]["state"] == "in development")
    step(3, "dev2", "next", want=lambda o, e: o == "none")
    step(2, "dev1", "handoff", "1", stdin="done", want=lambda o, e: "no_commits" in e)
    # the commit lands on main: in the clone the tester tests and in the stand-in GitHub
    g = lambda *a: subprocess.run(["git", *a], cwd=c.repo, capture_output=True, text=True, check=True).stdout.strip()
    Path(c.repo, "f").write_text("rename\n")
    g("-c", "commit.gpgsign=false", "commit", "-qam", "feat(x): rename with F2 (#1)")
    gh.repo(repo_name)["main"].append((g("rev-parse", "HEAD"), "feat(x): rename with F2 (#1)"))
    step(0, "dev1", "handoff", "1", stdin="Developer: done", want=lambda o, e: o["state"] == "ready for testing" and len(o["commits"]) == 1)
    step(0, "tester", "next", want=lambda o, e: o["ticket"]["state"] == "testing")
    step(2, "tester", "pass", "1", stdin="ok", want=lambda o, e: "gates" in e)
    c.green()
    step(2, "tester", "pass", "1", "--owner-check", stdin="ok", want=lambda o, e: "bad_card" in e)
    step(0, "tester", "pass", "1", "--owner-check", stdin=card, want=lambda o, e: o["state"] == "board review")
    step(0, "board", "show", "1", want=lambda o, e: o["origin"]["from"] == "passed")
    step(2, "board", "sendback", "1", stdin="no", want=lambda o, e: "wrong_state" in e)
    step(0, "board", "escalate", "1", stdin=card, want=lambda o, e: o["state"] == "human review" and o["telegram"] == "queued")
    step(2, "board", "answer", "1", stdin="OK", want=lambda o, e: "wrong_role" in e)
    step(0, "owner", "answer", "1", stdin="OK", want=lambda o, e: o["state"] == "needs triage")
    step(0, "board", "approve", "1", want=lambda o, e: o["state"] == "closed")
    step(1, "nobody", "whoami")
    i = gh.repo(repo_name)["issues"][1]
    ok = i["state"] == "closed" and i["comments"][-1]["body"] == "Owner: OK" and i["comments"][2]["body"].startswith("Tester: Looks right.")
    print(f"  {'ok  ' if ok else 'FAIL'} the issue: closed, comments signed by role ({len(i['comments'])} comments)")
    return all(steps) and ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--flow-py", help="livedu's scripts/flow.py, run unchanged against workspace w1")
    a = ap.parse_args()
    scratch = Path(tempfile.mkdtemp(prefix="flowee-wire-"))
    gh = GitHub()
    worker, url = start_worker(scratch, gh, "For Nick" if a.flow_py else "For the owner")
    results = {}
    try:
        def repo(name):
            d = scratch / name
            subprocess.run(["git", "init", "-q", "-b", "main", str(d)], check=True)
            Path(d, "f").write_text("start\n")
            subprocess.run(["git", "add", "f"], cwd=d, check=True)
            subprocess.run(["git", "-c", "user.name=T", "-c", "user.email=t@example.org", "-c", "commit.gpgsign=false", "commit", "-qm", "chore: start"], cwd=d, check=True)
            subprocess.run(["git", "config", "user.name", "T"], cwd=d, check=True)
            subprocess.run(["git", "config", "user.email", "t@example.org"], cwd=d, check=True)
            return d
        if a.flow_py:
            r1 = repo("livedu-client")
            c = Client("livedu flow.py", [sys.executable, a.flow_py],
                       lambda who: {"LIVEDU_FLOW_URL": url, "LIVEDU_FLOW_AS": who, "LIVEDU_FLOW_TOKEN": f"w1-{who}"}, "flow-gates.json", r1)
            print(f"{c.name} -> {url}/v1 (workspace w1 by token)")
            results[c.name] = walk(c, gh, "acme/w1", "For Nick")
        r2 = repo("flowee-client")
        c = Client("flowee.py", [sys.executable, str(ROOT / "client/flowee.py")],
                   lambda who: {"FLOWEE_URL": url, "FLOWEE_WORKSPACE": "w2", "FLOWEE_AS": who, "FLOWEE_TOKEN": f"w2-{who}", "FLOWEE_CONFIG": str(scratch / "none.toml")},
                   "flowee-gates.json", r2)
        print(f"{c.name} -> {url}/w/w2/v1")
        results[c.name] = walk(c, gh, "acme/w2", "For the owner")
    finally:
        worker.terminate()
        worker.wait(timeout=30)
        gh.srv.shutdown()
        shutil.rmtree(scratch, ignore_errors=True)
    print("wire check:", ", ".join(f"{k} {'passed' if v else 'FAILED'}" for k, v in results.items()))
    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
