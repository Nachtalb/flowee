#!/usr/bin/env python3
"""Wire check: a ticket's whole walk through real clients against the Worker in `wrangler dev`.

Starts a stand-in GitHub and a stand-in GitLab (stdlib HTTP, in memory) and `wrangler dev` with trunk workspaces whose
tracker API is that stand-in, then walks a ticket from filing to closed with each client given:

  python3 test/e2e/wire.py [--flow-py PATH [--flow-env PREFIX] [--flow-heading TEXT]]

`client/flowee.py` always runs (workspace w2, URL /w/w2). `--flow-py` adds an external client written against the
same wire contract, run unchanged (workspace w1, plain /v1 paths resolved by its token): the proof that the API stays
wire-compatible with it. It reads `<PREFIX>_URL`, `<PREFIX>_AS` and `<PREFIX>_TOKEN`, and writes owner cards under
`### <TEXT>`.
Then flowee.py walks a `pr-release` ticket (workspace w3: pull requests with a required check, releases with a held
card and the tested tag) through a branch pushed to a scratch bare repository the stand-in GitHub reads, and the same
two walks run on GitLab (workspaces g2 and g3, a nested `acme/team/<id>` project): issues, notes, a merge request,
its pipeline, the release and the tag through the GitLab adapter.
Everything lives in a scratch directory that is removed at the end; wrangler is stopped at the end.
"""
import argparse, hashlib, json, os, re, shutil, socket, subprocess, sys, tempfile, threading, time, urllib.parse
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

            do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = do_HEAD = go

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_port}"

    def repo(self, name):
        return self.repos.setdefault(name, {"issues": {}, "main": [], "comments": 0, "pulls": [], "checks": {}, "release": None, "tags": {}, "bare": None})

    def code(self, r, method, rest, q, body):
        """Branches (read from the scratch bare repository), pull requests, checks, releases, tags."""
        git = lambda *a: subprocess.run(["git", "-C", str(r["bare"]), *a], capture_output=True, text=True)
        head = lambda b: (git("rev-parse", "-q", "--verify", f"refs/heads/{b}").stdout.strip() or None) if r["bare"] else None
        pull = lambda p: {**p, "head": {**p["head"], "sha": head(p["head"]["ref"]) or p["head"]["sha"]}}
        if mm := re.match(r"^/git/ref/heads/(.+)$", rest):
            sha = head(mm.group(1))
            return (200, {"object": {"sha": sha}}) if sha else (404, {"message": "Not Found"})
        if re.match(r"^/git/refs/heads/", rest) and method == "DELETE":
            return 204, {}
        if rest == "/pulls" and method == "GET":
            want = urllib.parse.unquote(q.get("head", "")).split(":")[-1]
            return 200, [pull(p) for p in r["pulls"] if (not want or p["head"]["ref"] == want) and (q.get("state") == "all" or p["state"] == q.get("state"))]
        if rest == "/pulls" and method == "POST":
            n = 100 + len(r["pulls"]) + 1
            r["pulls"].append({"number": n, "title": body["title"], "body": body["body"], "html_url": f"https://github.test/pull/{n}", "head": {"ref": body["head"], "sha": head(body["head"])},
                               "base": {"ref": body["base"]}, "state": "open", "merged_at": None, "merge_commit_sha": None, "user": {"login": "dev"}})
            return 201, pull(r["pulls"][-1])
        if mm := re.match(r"^/pulls/(\d+)(/merge)?$", rest):
            p = next((x for x in r["pulls"] if x["number"] == int(mm.group(1))), None)
            if not p:
                return 404, {"message": "Not Found"}
            if mm.group(2) and method == "PUT":
                sha = hashlib.sha1(f"merge {p['number']}".encode()).hexdigest()
                r["main"].append((sha, body.get("commit_title") or p["title"]))
                p.update(state="closed", merged_at="2026-11-21T00:00:00Z", merge_commit_sha=sha)
                return 200, {"sha": sha, "merged": True}
            if method == "PATCH":
                p.update(body)
            return 200, pull(p)
        if mm := re.match(r"^/commits/(\w+)/check-runs$", rest):
            return 200, {"check_runs": r["checks"].get(mm.group(1), [])}
        if re.match(r"^/commits/\w+/status$", rest):
            return 200, {"statuses": []}
        if rest == "/releases/latest":
            return (200, r["release"]) if r["release"] else (404, {"message": "Not Found"})
        if mm := re.match(r"^/git/ref/tags/(.+)$", rest):
            t = r["tags"].get(mm.group(1))
            return (200, {"object": {"sha": t, "type": "commit"}}) if t else (404, {"message": "Not Found"})
        if rest == "/git/refs" and method == "POST":
            r["tags"][body["ref"].replace("refs/tags/", "")] = body["sha"]
            return 201, {}
        if (mm := re.match(r"^/git/refs/tags/(.+)$", rest)) and method == "PATCH":
            r["tags"][mm.group(1)] = body["sha"]
            return 200, {}
        return None

    def handle(self, method, path, body):
        url, _, query = path.partition("?")
        q = dict(x.split("=", 1) for x in query.split("&") if "=" in x)
        m = re.match(r"^/repos/([^/]+/[^/]+)(/.*)$", url)
        if not m:
            return 501, {"message": f"no route {method} {path}"}
        r, rest = self.repo(m.group(1)), m.group(2)
        if (x := self.code(r, method, rest, q, body)) is not None:
            return x
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
            if mm.group(1) == mm.group(2):
                return 200, {"status": "identical"}
            idx = lambda s: len(r["main"]) - 1 if s == "main" else next((k for k, (x, _) in enumerate(r["main"]) if x == s), -1)
            a, b = idx(mm.group(1)), idx(mm.group(2))
            if a < 0 or b < 0:
                return 404, {"message": "Not Found"}
            return 200, {"status": "identical" if a == b else "ahead" if a < b else "behind"}
        return 501, {"message": f"no route {method} {path}"}


class GitLab(GitHub):
    """The same in-memory repositories as GitHub keeps (so the walks read them alike), served as GitLab's REST API v4."""

    USERS = {"owner": 1, "dev": 2}

    def handle(self, method, path, body):
        url, _, query = path.partition("?")
        q = {}
        for x in query.split("&"):
            if "=" in x:
                k, v = x.split("=", 1)
                q.setdefault(urllib.parse.unquote(k), []).append(urllib.parse.unquote(v))
        one = lambda k, d=None: q.get(k, [d])[0]
        if url == "/api/v4/users":
            u = one("username", "")
            return 200, [{"id": self.USERS.get(u, 99), "username": u}]
        m = re.match(r"^/api/v4/projects/([^/]+)(/.*)?$", url)
        if not m:
            return 501, {"message": f"no route {method} {path}"}
        name, rest = urllib.parse.unquote(m.group(1)), urllib.parse.unquote(m.group(2) or "")
        r = self.repo(name)
        git = lambda *a: subprocess.run(["git", "-C", str(r["bare"]), *a], capture_output=True, text=True) if r["bare"] else None
        head = lambda b: ((git("rev-parse", "-q", "--verify", f"refs/heads/{b}").stdout.strip() or None) if r["bare"] else None)
        main_idx = lambda s: len(r["main"]) - 1 if s == "main" else next((k for k, (x, _) in enumerate(r["main"]) if x == s), -1)
        resolve = lambda s: (r["main"][-1][0] if r["main"] else None) if s == "main" else s if main_idx(s) >= 0 else head(s) or (s if r["bare"] and git("cat-file", "-e", s).returncode == 0 else None)
        user = lambda login: {"id": self.USERS.get(login, 99), "username": login}
        issue = lambda i: {"id": 1000 + i["number"], "iid": i["number"], "title": i["title"], "description": i["body"], "state": "opened" if i["state"] == "open" else "closed",
                           "labels": [x["name"] for x in i["labels"]], "assignees": [{"username": a["login"]} for a in i["assignees"]], "created_at": i["created_at"],
                           "updated_at": i["updated_at"], "web_url": f"https://gitlab.test/{name}/-/issues/{i['number']}", "issue_type": "issue"}

        def mr(p):
            sha = head(p["head"]["ref"]) if p["state"] == "open" else p["head"]["sha"]
            return {"iid": p["number"], "title": p["title"], "description": p["body"], "web_url": p["html_url"], "source_branch": p["head"]["ref"], "target_branch": p["base"]["ref"],
                    "sha": sha or p["head"]["sha"], "state": "merged" if p["merged_at"] else "opened" if p["state"] == "open" else "closed",
                    "merge_commit_sha": p["merge_commit_sha"], "squash_commit_sha": None, "author": {"username": p["user"]["login"]}}

        def status(c):
            if c["status"] != "completed":
                return "running"
            return {"success": "success", "skipped": "skipped", "cancelled": "canceled"}.get(c["conclusion"], "failed")

        if rest == "" and method == "GET":
            return 200, {"id": 1, "path_with_namespace": name}
        if rest == "/issues" and method == "GET":
            return 200, [issue(i) for i in r["issues"].values() if (i["state"] == "open") == (one("state") == "opened")]
        if rest == "/issues" and method == "POST":
            n = len(r["issues"]) + 1
            labels = [x for x in body.get("labels", "").split(",") if x]
            r["issues"][n] = {"number": n, "title": body["title"], "body": body.get("description"), "state": "open", "labels": [{"name": x} for x in labels], "assignees": [],
                              "created_at": "2026-11-01T00:00:00Z", "updated_at": "2026-11-02T00:00:00Z", "comments": []}
            return 201, issue(r["issues"][n])
        if mm := re.match(r"^/issues/(\d+)$", rest):
            i = r["issues"].get(int(mm.group(1)))
            if not i:
                return 404, {"message": "404 Not found"}
            if method == "PUT":
                if "labels" in body:
                    i["labels"] = [{"name": x} for x in body["labels"].split(",") if x]
                if "assignee_ids" in body:
                    i["assignees"] = [{"login": k} for k, v in self.USERS.items() if v in body["assignee_ids"]]
                if body.get("state_event"):
                    i["state"] = "closed" if body["state_event"] == "close" else "open"
                i.update({k: body[v] for k, v in (("title", "title"), ("body", "description")) if v in body})
            return 200, issue(i)
        if mm := re.match(r"^/issues/(\d+)/notes$", rest):
            i = r["issues"][int(mm.group(1))]
            if method == "POST":
                r["comments"] += 1
                i["comments"].append({"id": r["comments"], "body": body["body"]})
                return 201, {**i["comments"][-1], "system": False}
            return 200, [{**c, "system": False} for c in i["comments"]]
        if rest == "/repository/commits":
            return 200, [{"id": s, "message": msg} for s, msg in reversed(r["main"])]
        if mm := re.match(r"^/repository/commits/([^/]+)/statuses$", rest):
            return 200, [{"id": k, "name": c["name"], "status": status(c), "allow_failure": False} for k, c in enumerate(r["checks"].get(mm.group(1), []))]
        if mm := re.match(r"^/repository/commits/([^/]+)$", rest):
            s = resolve(mm.group(1))
            return (200, {"id": s}) if s else (404, {"message": "404 Commit Not Found"})
        if rest == "/repository/merge_base":
            a, b = (resolve(x) for x in q.get("refs[]", []))
            if not a or not b:
                return 404, {"message": "404 Not found"}
            if main_idx(a) >= 0 and main_idx(b) >= 0:
                return 200, {"id": r["main"][min(main_idx(a), main_idx(b))][0]}
            mb = git("merge-base", a, b)
            return (200, {"id": mb.stdout.strip()}) if mb and mb.returncode == 0 else (404, {"message": "404 Not found"})
        if mm := re.match(r"^/repository/branches/(.+)$", rest):
            sha = head(mm.group(1))
            if method == "DELETE":
                return 204, {}
            return (200, {"name": mm.group(1), "commit": {"id": sha}}) if sha else (404, {"message": "404 Branch Not Found"})
        if rest == "/merge_requests" and method == "GET":
            want, st = one("source_branch"), one("state")
            return 200, [mr(p) for p in r["pulls"] if (not want or p["head"]["ref"] == want) and (st == "all" or mr(p)["state"] == st)]
        if rest == "/merge_requests" and method == "POST":
            n = 100 + len(r["pulls"]) + 1
            r["pulls"].append({"number": n, "title": body["title"], "body": body["description"], "html_url": f"https://gitlab.test/{name}/-/merge_requests/{n}",
                               "head": {"ref": body["source_branch"], "sha": head(body["source_branch"])}, "base": {"ref": body["target_branch"]}, "state": "open",
                               "merged_at": None, "merge_commit_sha": None, "user": {"login": "dev"}})
            return 201, mr(r["pulls"][-1])
        if mm := re.match(r"^/merge_requests/(\d+)(/merge)?$", rest):
            p = next((x for x in r["pulls"] if x["number"] == int(mm.group(1))), None)
            if not p:
                return 404, {"message": "404 Not found"}
            if mm.group(2) and method == "PUT":
                if p["state"] != "open" or body.get("sha") != head(p["head"]["ref"]):
                    return 409, {"message": "SHA does not match HEAD of source branch"}
                sha = hashlib.sha1(f"merge {p['number']}".encode()).hexdigest()
                r["main"].append((sha, body.get("squash_commit_message") or body.get("merge_commit_message") or p["title"]))
                p.update(state="closed", merged_at="2026-11-21T00:00:00Z", merge_commit_sha=sha, head={**p["head"], "sha": head(p["head"]["ref"])})
                return 200, mr(p)
            if method == "PUT":
                p.update({k: body[v] for k, v in (("title", "title"), ("body", "description")) if v in body})
            return 200, mr(p)
        if rest == "/pipelines":
            cs = r["checks"].get(one("sha"), [])
            return 200, [{"id": 1, "status": "success" if all(status(c) == "success" for c in cs) else "running"}] if cs else []
        if rest == "/releases":
            x = r["release"]
            return 200, [{"tag_name": x["tag_name"], "name": x["name"], "description": x["body"], "released_at": x["published_at"], "_links": {"self": x["html_url"]}}] if x else []
        if mm := re.match(r"^/repository/tags/(.+)$", rest):
            t = r["tags"].get(mm.group(1))
            if not t:
                return 404, {"message": "404 Tag Not Found"}
            if method == "DELETE":
                del r["tags"][mm.group(1)]
                return 204, {}
            return 200, {"name": mm.group(1), "commit": {"id": t}}
        if rest == "/repository/tags" and method == "POST":
            r["tags"][body["tag_name"]] = resolve(body["ref"]) or body["ref"]
            return 201, {"name": body["tag_name"]}
        return 501, {"message": f"no route {method} {path}"}


def workspace(id, heading, gh, preset="trunk", features=None, gitlab=False):
    tracker = ({"type": "gitlab", "repos": [f"acme/team/{id}"], "api": f"{gh.url}/api/v4", "token": "GITLAB_TOKEN"} if gitlab
               else {"type": "github", "repos": [f"acme/{id}"], "api": gh.url, "token": "GITHUB_TOKEN"})
    return {"flowee": 1, "id": id, "flow": {"preset": preset}, **({"features": features} if features else {}),
            "tracker": tracker,
            "roles": [{"instance": w, "role": ROLE[w], "secret": f"{id.upper()}_{w.upper()}"} for w in WHO],
            "owners": [{"name": "Owner", "tracker": "owner"}], "texts": {"cardHeading": heading}}


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_worker(scratch, gh, gl, heading1):
    port = free_port()
    rel = {"pullRequests": {"checks": ["build"]}, "releases": {"testedTag": "tested", "checks": ["build"]}}
    w3 = workspace("w3", "For the owner", gh, "pr-release", rel)
    g3 = workspace("g3", "For the owner", gl, "pr-release", rel, gitlab=True)
    config = {"flowee": 1, "workspaces": [workspace("w1", heading1, gh), workspace("w2", "For the owner", gh), w3, workspace("g2", "For the owner", gl, gitlab=True), g3]}
    args = ["npx", "wrangler", "dev", "--ip", "127.0.0.1", "--port", str(port), "--persist-to", str(scratch / "state"),
            "--show-interactive-dev-session=false", "--test-scheduled", "--var", f"FLOWEE_CONFIG:{json.dumps(config)}", "--var", "GITHUB_TOKEN:gh-test",
            "--var", "GITLAB_TOKEN:gl-test"]
    for ws in ("w1", "w2", "w3", "g2", "g3"):
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


def walk_pr(c, gh, url, repo_name):
    """pr-release: branch + pull request, a required check, the pass merging it, a held card, the release, the tested tag."""
    card = "Works.\n\n### For the owner\nKind: test\nChanged: rename works with F2\nCheck:\n- press F2 on a file"
    steps = []
    g = lambda *a: subprocess.run(["git", *a], cwd=c.repo, capture_output=True, text=True, check=True, env=dict(os.environ, **c.env("dev1"))).stdout.strip()
    r = gh.repo(repo_name)

    def step(expect_rc, who, *args, stdin="", want=None):
        rc, out, err = c(who, *args, stdin=stdin)
        try:
            ok = rc == expect_rc and (want is None or bool(want(out, err)))
        except (KeyError, TypeError):
            ok = False
        steps.append(ok)
        print(f"  {'ok  ' if ok else 'FAIL'} {who:6} {' '.join(args):28} rc={rc} {json.dumps(out) if not isinstance(out, str) else out} {err[-200:]}")

    def check(what, ok):
        steps.append(ok)
        print(f"  {'ok  ' if ok else 'FAIL'} {what}")

    def cron(until=lambda: True):
        """Fires the Worker's cron; it finishes in waitUntil, so wait (bounded) for its effect."""
        import urllib.request
        urllib.request.urlopen(urllib.request.Request(f"{url}/__scheduled?cron=*", headers={"User-Agent": "wire"}), timeout=60).read()
        for _ in range(50):
            if until():
                return
            time.sleep(0.2)

    step(0, "board", "file", "Rename", "with", "F2", stdin="## Acceptance\n- it works", want=lambda o, e: o["n"] == 1)
    step(0, "board", "next", want=lambda o, e: o["ticket"]["n"] == 1)
    step(0, "board", "triage", "1", stdin="specified", want=lambda o, e: o["state"] == "ready")
    step(0, "dev1", "next", want=lambda o, e: o["ticket"]["state"] == "in development")
    step(0, "dev1", "branch", "1", want=lambda o, e: o == "flowee/1")
    Path(c.repo, "f").write_text("rename\n")
    g("commit", "-S", "-qam", "feat(x): rename with F2 (#1)")
    head = g("rev-parse", "HEAD")
    step(2, "dev1", "merge", "1", want=lambda o, e: "not_found" in e)  # the flow merges, not the developer
    step(0, "dev1", "pr", "1", want=lambda o, e: o["pull"]["number"] == 101 and o["pull"]["branch"] == "flowee/1")
    check("the pull request: from flowee/1, titled with the ticket", r["pulls"][0]["title"] == "Rename with F2 (#1)" and r["pulls"][0]["body"] == "Closes #1")
    step(3, "dev1", "checks", "1", want=lambda o, e: o.startswith("pending"))
    step(2, "dev1", "handoff", "1", stdin="done", want=lambda o, e: "checks_pending" in e)
    r["checks"][head] = [{"name": "build", "status": "completed", "conclusion": "success"}]
    step(0, "dev1", "checks", "1", want=lambda o, e: o == "green")
    step(0, "dev1", "handoff", "1", stdin="done", want=lambda o, e: o["state"] == "ready for testing")
    step(0, "tester", "next", want=lambda o, e: o["ticket"]["state"] == "testing")
    step(0, "tester", "branch", "1", want=lambda o, e: o == "flowee/1")
    c.green()
    step(0, "tester", "pass", "1", "--owner-check", stdin=card, want=lambda o, e: o["state"] == "board review" and o["merged"])
    merge = r["main"][-1][0] if r["main"] else ""
    check("the pass merged the pull request onto main", r["pulls"][0]["state"] == "closed" and r["main"][-1][1] == "Rename with F2 (#1)")
    step(0, "board", "next", want=lambda o, e: o["ticket"]["origin"]["from"] == "passed")
    step(0, "board", "escalate", "1", stdin=card, want=lambda o, e: o["state"] == "awaiting release")
    cron()
    time.sleep(2)  # nothing may change: give the cron its time to finish
    check("no release yet: the card waits", any(l["name"] == "awaiting release" for l in r["issues"][1]["labels"]))
    r["release"] = {"tag_name": "v1.0.0", "name": "1.0.0", "body": f"build from `{merge}`", "html_url": "https://github.test/r/1", "published_at": "2026-11-22T00:00:00Z"}
    r["checks"][merge] = [{"name": "build", "status": "completed", "conclusion": "success"}]
    cron(lambda: any(l["name"] == "human review" for l in r["issues"][1]["labels"]) and r["tags"].get("tested") == merge)
    check("released: the card reached the owner's inbox", any(l["name"] == "human review" for l in r["issues"][1]["labels"]))
    check("the tested tag moved onto the merge commit", r["tags"].get("tested") == merge)
    step(0, "owner", "answer", "1", stdin="OK", want=lambda o, e: o["state"] == "needs triage")
    step(0, "board", "approve", "1", want=lambda o, e: o["state"] == "closed")
    return all(steps)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--flow-py", help="an external client with the same wire contract, run unchanged against workspace w1")
    ap.add_argument("--flow-env", default="FLOW", help="the external client's environment prefix (<PREFIX>_URL, _AS, _TOKEN)")
    ap.add_argument("--flow-heading", default="For the owner", help="the card heading the external client writes")
    a = ap.parse_args()
    scratch = Path(tempfile.mkdtemp(prefix="flowee-wire-"))
    gh = GitHub()
    gl = GitLab()
    worker, url = start_worker(scratch, gh, gl, a.flow_heading)
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
            r1 = repo("external-client")
            e = a.flow_env
            c = Client("external flow.py", [sys.executable, a.flow_py],
                       lambda who: {f"{e}_URL": url, f"{e}_AS": who, f"{e}_TOKEN": f"w1-{who}"}, "flow-gates.json", r1)
            print(f"{c.name} -> {url}/v1 (workspace w1 by token)")
            results[c.name] = walk(c, gh, "acme/w1", a.flow_heading)
        r2 = repo("flowee-client")
        c = Client("flowee.py", [sys.executable, str(ROOT / "client/flowee.py")],
                   lambda who: {"FLOWEE_URL": url, "FLOWEE_WORKSPACE": "w2", "FLOWEE_AS": who, "FLOWEE_TOKEN": f"w2-{who}", "FLOWEE_CONFIG": str(scratch / "none.toml")},
                   "flowee-gates.json", r2)
        print(f"{c.name} -> {url}/w/w2/v1")
        results[c.name] = walk(c, gh, "acme/w2", "For the owner")
        # pr-release: a signing key, a bare origin the stand-in tracker reads branches from, a clone pushing to it
        gnupg = scratch / "gnupg"
        gnupg.mkdir(mode=0o700)
        subprocess.run(["gpg", "--homedir", str(gnupg), "--batch", "--passphrase", "", "--quick-gen-key", "T <t@example.org>", "ed25519", "sign", "never"], check=True, capture_output=True)

        def pr_client(ws, tracker, project):
            bare = scratch / f"{ws}-origin.git"
            subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(bare)], check=True)
            d = repo(f"{ws}-client")
            subprocess.run(["git", "remote", "add", "origin", str(bare)], cwd=d, check=True)
            subprocess.run(["git", "config", "user.signingkey", "t@example.org"], cwd=d, check=True)
            subprocess.run(["git", "push", "-q", "origin", "HEAD:main"], cwd=d, check=True)
            tracker.repo(project)["bare"] = bare
            return Client(f"flowee.py pr-release ({ws})", [sys.executable, str(ROOT / "client/flowee.py")],
                          lambda who: {"FLOWEE_URL": url, "FLOWEE_WORKSPACE": ws, "FLOWEE_AS": who, "FLOWEE_TOKEN": f"{ws}-{who}", "FLOWEE_CONFIG": str(scratch / "none.toml"), "GNUPGHOME": str(gnupg)},
                          "flowee-gates.json", d)

        c = pr_client("w3", gh, "acme/w3")
        print(f"{c.name} -> {url}/w/w3/v1")
        results[c.name] = walk_pr(c, gh, url, "acme/w3")
        # GitLab: the same walks through the GitLab adapter, a nested project
        rg = repo("g2-client")
        c = Client("flowee.py on GitLab", [sys.executable, str(ROOT / "client/flowee.py")],
                   lambda who: {"FLOWEE_URL": url, "FLOWEE_WORKSPACE": "g2", "FLOWEE_AS": who, "FLOWEE_TOKEN": f"g2-{who}", "FLOWEE_CONFIG": str(scratch / "none.toml")},
                   "flowee-gates.json", rg)
        print(f"{c.name} -> {url}/w/g2/v1")
        results[c.name] = walk(c, gl, "acme/team/g2", "For the owner")
        c = pr_client("g3", gl, "acme/team/g3")
        print(f"{c.name} -> {url}/w/g3/v1")
        results[c.name] = walk_pr(c, gl, url, "acme/team/g3")
    finally:
        worker.terminate()
        worker.wait(timeout=30)
        gh.srv.shutdown()
        gl.srv.shutdown()
        shutil.rmtree(scratch, ignore_errors=True)
    print("wire check:", ", ".join(f"{k} {'passed' if v else 'FAILED'}" for k, v in results.items()))
    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
