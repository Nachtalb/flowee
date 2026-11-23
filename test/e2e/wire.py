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
Last, a webhook walk (workspace w4): after the deploy's /setup the cron registers the repository's webhook in the
stand-in GitHub, which then POSTs signed deliveries; `queue` answers from the webhook-fed mirror without a listing.
Everything lives in a scratch directory that is removed at the end; wrangler is stopped at the end.

`--runtime bun` runs the same walks against the self-hosted runtime (`bun src/runtime/bun/main.ts`), `--runtime docker`
against its image (`--image`, default flowee-test-scratch:dev; container and volume named flowee-test-wire-*, removed
at the end). Both add a polling walk (workspace w5: a chat with no public URL, so a stand-in Telegram hands updates out
by getUpdates and the tracker is polled on the tick), then restart the process with FLOWEE_PUBLIC_URL set, check the
stored state survived, and run the webhook walk with that public URL.
"""
import argparse, hashlib, hmac, json, os, re, shutil, socket, subprocess, sys, tempfile, threading, time, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SELF_TICKING = False  # the self-hosted runtime runs its own tick (FLOWEE_TICK_SECONDS=1); wrangler needs __scheduled
WHO = ["board", "dev1", "dev2", "tester", "owner"]
ROLE = {"board": "board", "dev1": "developer", "dev2": "developer", "tester": "tester", "owner": "owner"}


class GitHub:
    """Issues, comments, commits on main and compare for one repo per path prefix."""

    def __init__(self):
        self.repos = {}
        self.calls = []  # (method, path) of every request
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
        return self.repos.setdefault(name, {"issues": {}, "main": [], "comments": 0, "pulls": [], "checks": {}, "release": None, "tags": {}, "bare": None, "hooks": []})

    def deliver(self, name, event, payload, delivery, secret=None):
        """POSTs a delivery to the repository's webhook the way GitHub does (X-Hub-Signature-256 over the raw body)."""
        import urllib.request, urllib.error
        h = self.repo(name)["hooks"][0]
        body = json.dumps({**payload, "repository": {"full_name": name}}).encode()
        sig = hmac.new((secret or h["config"]["secret"]).encode(), body, hashlib.sha256).hexdigest()
        req = urllib.request.Request(h["config"]["url"], data=body, method="POST", headers={
            "content-type": "application/json", "user-agent": "GitHub-Hookshot/wire", "x-github-event": event,
            "x-github-delivery": delivery, "x-hub-signature-256": f"sha256={sig}"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code

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
        if rest == "/releases":
            return 200, [r["release"]] if r["release"] else []
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
        self.calls.append((method, url))
        if rest == "/hooks" and method == "GET" and r["hooks"] is not None:
            return 200, [{k: v for k, v in h.items() if k != "config"} | {"config": {"url": h["config"]["url"]}} for h in r["hooks"]]
        if rest == "/hooks" and method == "POST":
            r["hooks"].append({"id": len(r["hooks"]) + 1, "active": True, "events": body["events"], "config": body["config"], "last_response": {"code": None, "status": "unused", "message": None}})
            return 201, r["hooks"][-1]
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


class Telegram:
    """The Bot API by getUpdates: hands out `pending` updates after the offset; records every call; message ids."""

    def __init__(self):
        self.calls, self.pending, self.sent, self.next_id = [], [], [], 1000
        self.lock = threading.Lock()
        me = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                try:
                    body = json.loads(raw) if (self.headers.get("content-type") or "").startswith("application/json") else {}
                except ValueError:
                    body = {}
                data = json.dumps(me.handle(self.path, body)).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        class Quiet(ThreadingHTTPServer):
            def handle_error(self, *a):  # a long poll the runtime aborts when it stops
                pass

        self.srv = Quiet(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_port}"

    def handle(self, path, body):
        method = path.rsplit("/", 1)[-1]
        with self.lock:
            self.calls.append((method, body))
        if method == "getUpdates":
            for _ in range(20):  # a short long-poll
                due = [u for u in self.pending if u["update_id"] >= body.get("offset", 0)]
                if due:
                    return {"ok": True, "result": due}
                time.sleep(0.05)
            return {"ok": True, "result": []}
        if method.startswith("send") or method == "editMessageText":
            with self.lock:
                self.next_id += 1
                self.sent.append((method, body, self.next_id))
                return {"ok": True, "result": {"message_id": body.get("message_id") or self.next_id}}
        if method == "getWebhookInfo":
            return {"ok": True, "result": {"url": ""}}
        return {"ok": True, "result": True}

    def of(self, method):
        return [b for m, b in self.calls if m == method]


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


OWNER_CHAT = "4242"
BOT_TOKEN = "4711:wire-bot"


def config_for(gh, gl, heading1, polling):
    rel = {"pullRequests": {"checks": ["build"]}, "releases": {"testedTag": "tested", "checks": ["build"]}}
    w3 = workspace("w3", "For the owner", gh, "pr-release", rel)
    g3 = workspace("g3", "For the owner", gl, "pr-release", rel, gitlab=True)
    w4 = {**workspace("w4", "For the owner", gh), "sync": {"webhooks": "auto"}}
    ws = [workspace("w1", heading1, gh), workspace("w2", "For the owner", gh), w3, workspace("g2", "For the owner", gl, gitlab=True), g3, w4]
    if polling:
        # a chat without a public URL: Telegram by getUpdates, the tracker polled on the tick
        w5 = workspace("w5", "For the owner", gh)
        w5["owners"] = [{"name": "Owner", "tracker": "owner", "chat": OWNER_CHAT}]
        w5["chat"] = {"type": "telegram", "token": "W5_BOT", "webhookSecret": "W5_HOOK", "chatId": OWNER_CHAT}
        ws.append(w5)
    return {"flowee": 1, "workspaces": ws}


def secrets():
    out = {"GITHUB_TOKEN": "gh-test", "GITLAB_TOKEN": "gl-test", "FLOWEE_KEY": "wire-key", "W5_BOT": BOT_TOKEN}
    for ws in ("w1", "w2", "w3", "g2", "g3", "w4", "w5"):
        for w in WHO:
            out[f"{ws.upper()}_{w.upper()}"] = hashlib.sha256(f"{ws}-{w}".encode()).hexdigest()
    return out


class SelfHosted:
    """The bun runtime as a process (`bun`) or its image (`docker`) on a fixed port and data directory/volume."""

    def __init__(self, kind, scratch, config, tg, image):
        self.kind, self.config, self.tg, self.image = kind, config, tg, image
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.data = scratch / "data"
        self.name = f"flowee-test-wire-{os.getpid()}"
        self.p = None

    def env(self, public_url=None):
        e = {**secrets(), "FLOWEE_CONFIG": json.dumps(self.config), "FLOWEE_PORT": str(self.port), "FLOWEE_HOST": "127.0.0.1",
             "FLOWEE_TELEGRAM_API": self.tg.url, "FLOWEE_TICK_SECONDS": "1"}
        if public_url:
            e["FLOWEE_PUBLIC_URL"] = public_url
        return e

    def start(self, public_url=None):
        e = self.env(public_url)
        if self.kind == "bun":
            self.p = subprocess.Popen(["bun", "src/runtime/bun/main.ts"], cwd=ROOT, env=dict(os.environ, **e, FLOWEE_DATA=str(self.data)),
                                      stdout=subprocess.DEVNULL, stderr=open(self.data.parent / "flowee.log", "a"))
        else:
            args = ["docker", "run", "-d", "--name", self.name, "--network", "host", "-v", f"{self.name}:/data"]
            for k, v in e.items():
                args += ["-e", f"{k}={v}"]
            subprocess.run([*args, self.image], check=True, capture_output=True)
        for _ in range(150):
            try:
                if urllib.request.urlopen(urllib.request.Request(f"{self.url}/health", headers={"User-Agent": "wire"}), timeout=2).status == 200:
                    return
            except OSError:
                pass
            time.sleep(0.1)
        raise SystemExit(f"the {self.kind} runtime did not become healthy")

    def health(self):
        """The image's own HEALTHCHECK command, run in the container (no shell in it)."""
        if self.kind != "docker":
            return True
        return subprocess.run(["docker", "exec", self.name, "/flowee", "health"]).returncode == 0

    def stop(self):
        if self.kind == "bun" and self.p:
            self.p.terminate()  # SIGTERM: the graceful stop
            self.p.wait(timeout=30)
        elif self.kind == "docker":
            subprocess.run(["docker", "stop", "-t", "30", self.name], capture_output=True)
            subprocess.run(["docker", "rm", "-f", self.name], capture_output=True)

    def remove(self):
        self.stop()
        if self.kind == "docker":
            subprocess.run(["docker", "volume", "rm", "-f", self.name], capture_output=True)


def start_worker(scratch, gh, gl, heading1):
    port = free_port()
    config = config_for(gh, gl, heading1, False)
    args = ["npx", "wrangler", "dev", "--ip", "127.0.0.1", "--port", str(port), "--persist-to", str(scratch / "state"),
            "--show-interactive-dev-session=false", "--test-scheduled", "--var", f"FLOWEE_CONFIG:{json.dumps(config)}", "--var", "GITHUB_TOKEN:gh-test",
            "--var", "GITLAB_TOKEN:gl-test", "--var", "FLOWEE_KEY:wire-key"]
    for ws in ("w1", "w2", "w3", "g2", "g3", "w4"):
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
        if not SELF_TICKING:  # wrangler dev's cron trigger; the self-hosted runtime ticks by itself
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


def walk_hooks(c, gh, url, repo_name):
    """Webhooks: registered by the cron after /setup, signed deliveries, `queue` from the mirror without a listing."""
    import urllib.request
    steps = []
    r = gh.repo(repo_name)

    def check(what, ok):
        steps.append(ok)
        print(f"  {'ok  ' if ok else 'FAIL'} {what}")

    def get(path):
        return json.loads(urllib.request.urlopen(urllib.request.Request(f"{url}{path}", headers={"User-Agent": "wire"}), timeout=60).read())

    def until(cond):
        for _ in range(50):
            if cond():
                return True
            time.sleep(0.2)
        return cond()

    def queue():
        rc, out, err = c("board", "queue")
        return out if rc == 0 else {}

    get("/setup")  # what the deploy calls: the workspace learns its public URL
    if not SELF_TICKING:  # wrangler dev's cron trigger; the self-hosted runtime ticks by itself
        urllib.request.urlopen(urllib.request.Request(f"{url}/__scheduled?cron=*", headers={"User-Agent": "wire"}), timeout=60).read()
    check("the cron registered the webhook", until(lambda: bool(r["hooks"])))
    if not r["hooks"]:
        return False
    h = r["hooks"][0]
    check(f"its address is {url}/hooks/w4/w4, signed, json", h["config"].get("url") == f"{url}/hooks/w4/w4" and len(h["config"].get("secret", "")) == 64 and h["config"].get("content_type") == "json")
    check("ping accepted", r["hooks"] and gh.deliver(repo_name, "ping", {"zen": "Speak like a human.", "hook_id": 1}, "d-ping") == 200)
    check("queue answers from the mirror", until(lambda: queue().get("source") == "mirror"))
    rc, out, err = c("board", "file", "Webhooks", "walk", stdin="## Acceptance\n- it works")
    check("a ticket filed", rc == 0)
    listings = lambda: sum(1 for m, p in gh.calls if m == "GET" and p == f"/repos/{repo_name}/issues")
    before = listings()
    check("the issues event is accepted", gh.deliver(repo_name, "issues", {"action": "opened", "issue": {"number": 1}}, "d-1") == 200)
    check("a redelivery is accepted and changes nothing", gh.deliver(repo_name, "issues", {"action": "opened", "issue": {"number": 1}}, "d-1") == 200)
    check("a wrong signature is refused", gh.deliver(repo_name, "issues", {"action": "opened", "issue": {"number": 1}}, "d-2", secret="wrong") == 401)
    check("queue shows the new ticket from the mirror", until(lambda: queue().get("queue") == [1] and queue().get("source") == "mirror"))
    check("no listing of the tracker for it", listings() == before)
    return all(steps)


def walk_poll(c, gh, tg, rt, repo_name):
    """Polling: no public URL; the stand-in Telegram hands updates out by getUpdates, the tracker is listed on the tick."""
    import urllib.request
    steps = []
    r = gh.repo(repo_name)

    def check(what, ok):
        steps.append(ok)
        print(f"  {'ok  ' if ok else 'FAIL'} {what}")

    def until(cond, n=150):
        for _ in range(n):
            if cond():
                return True
            time.sleep(0.1)
        return cond()

    listings = lambda: sum(1 for m, p in gh.calls if m == "GET" and p == f"/repos/{repo_name}/issues")
    check("the bot's webhook was deleted before polling", until(lambda: bool(tg.of("deleteWebhook"))))
    check("getUpdates asks for the webhook's update types", until(lambda: any(b.get("allowed_updates") == ["message", "callback_query"] for b in tg.of("getUpdates"))))
    check("the profile was set at start, no webhook", bool(tg.of("setMyCommands")) and not tg.of("setWebhook"))
    tok = "w5-board"
    req = urllib.request.Request(f"{rt.url}/w/w5/v1/sync", headers={"User-Agent": "wire", "authorization": f"Bearer {tok}"})
    sync = (json.loads(urllib.request.urlopen(req, timeout=10).read()).get("sync", {}).get("repos") or [{}])[0]
    check(f"sync: polled, '{sync.get('reason')}'", sync.get("mode") == "poll" and "no public URL" in (sync.get("reason") or ""))
    first = listings()
    check("the tracker is listed on the tick without any command", until(lambda: listings() >= first + 2))
    # a card written in the tracker by someone else: found by polling, sent to the owner's chat
    n = len(r["issues"]) + 1
    r["issues"][n] = {"number": n, "title": "Colour", "body": "## Acceptance\n- it works", "state": "open", "state_reason": None, "labels": [{"name": "human review"}],
                      "assignees": [{"login": "owner"}], "created_at": "2026-11-01T00:00:00Z", "updated_at": "2026-11-03T00:00:00Z",
                      "html_url": f"https://github.test/{repo_name}/issues/{n}", "node_id": f"I_{n}", "comments": []}
    r["comments"] += 1
    r["issues"][n]["comments"].append({"id": r["comments"], "body": "Board: escalated\n\n### For the owner\nKind: question\nQuestion: Blue or green? I recommend blue."})
    card = lambda: next((b for b in tg.of("sendRichMessage") if b.get("chat_id") == OWNER_CHAT and "Blue or green" in json.dumps(b)), None)
    check("the card reached the owner's chat by polling the tracker", until(card, 300))
    mid = next((i for m, b, i in tg.sent if m == "sendRichMessage" and "Blue or green" in json.dumps(b)), None)
    bot = int(BOT_TOKEN.split(":")[0])
    tg.pending.append({"update_id": 7001, "message": {"message_id": 9001, "chat": {"id": int(OWNER_CHAT), "type": "private"}, "from": {"id": int(OWNER_CHAT), "is_bot": False, "first_name": "Owner"},
                                                       "text": "blue", "reply_to_message": {"message_id": mid, "from": {"id": bot, "is_bot": True}}}})
    answered = lambda: any("blue" in x["body"] and x["body"].startswith("Owner") for x in r["issues"][n]["comments"])
    check("the owner's reply, fetched by getUpdates, is the ticket's answer", until(answered, 300))
    check("the offset moved past it", until(lambda: any(b.get("offset") == 7002 for b in tg.of("getUpdates"))))
    return all(steps), n


def survived(rt, gh, tg, repo_name, n):
    """After the restart: the offset and the inbox are where they were; nothing answered or sent twice."""
    r = gh.repo(repo_name)
    answers = lambda: sum(1 for x in r["issues"][n]["comments"] if x["body"].startswith("Owner"))
    cards = lambda: sum(1 for b in tg.of("sendRichMessage") if "Blue or green" in json.dumps(b))
    a0, c0, g0 = answers(), cards(), len(tg.of("getUpdates"))
    for _ in range(100):
        if len(tg.of("getUpdates")) > g0 + 2:
            break
        time.sleep(0.1)
    time.sleep(2.5)  # two ticks
    later = tg.of("getUpdates")[g0:]
    ok = bool(later) and later[0].get("offset") == 7002 and answers() == a0 == 1 and cards() == c0 == 1 and rt.health()
    print(f"  {'ok  ' if ok else 'FAIL'} after the restart: getUpdates resumes at {later[0].get('offset') if later else None}, {answers()} answer, {cards()} card, healthy")
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--flow-py", help="an external client with the same wire contract, run unchanged against workspace w1")
    ap.add_argument("--flow-env", default="FLOW", help="the external client's environment prefix (<PREFIX>_URL, _AS, _TOKEN)")
    ap.add_argument("--flow-heading", default="For the owner", help="the card heading the external client writes")
    ap.add_argument("--runtime", choices=["wrangler", "bun", "docker"], default="wrangler", help="the Worker in wrangler dev, or the self-hosted runtime as a process or an image")
    ap.add_argument("--image", default="flowee-test-scratch:dev", help="the image --runtime docker runs")
    a = ap.parse_args()
    scratch = Path(tempfile.mkdtemp(prefix="flowee-wire-"))
    gh = GitHub()
    gl = GitLab()
    tg = Telegram()
    rt = worker = None
    if a.runtime == "wrangler":
        worker, url = start_worker(scratch, gh, gl, a.flow_heading)
    else:
        global SELF_TICKING
        SELF_TICKING = True
        rt = SelfHosted(a.runtime, scratch, config_for(gh, gl, a.flow_heading, True), tg, a.image)
        rt.data.mkdir()
        rt.start()
        url = rt.url
        print(f"{a.runtime} runtime -> {url} (Telegram stand-in {tg.url})")
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
        if rt:
            rp = repo("w5-client")
            c = Client("flowee.py polling", [sys.executable, str(ROOT / "client/flowee.py")],
                       lambda who: {"FLOWEE_URL": url, "FLOWEE_WORKSPACE": "w5", "FLOWEE_AS": who, "FLOWEE_TOKEN": f"w5-{who}", "FLOWEE_CONFIG": str(scratch / "none.toml")},
                       "flowee-gates.json", rp)
            print(f"{c.name} -> Telegram by getUpdates, the tracker polled (no public URL)")
            results[c.name], n = walk_poll(c, gh, tg, rt, "acme/w5")
            print(f"restart with FLOWEE_PUBLIC_URL={url}")
            rt.stop()
            rt.start(public_url=url)
            results["restart"] = survived(rt, gh, tg, "acme/w5", n)
        rw = repo("w4-client")
        c = Client("flowee.py webhooks", [sys.executable, str(ROOT / "client/flowee.py")],
                   lambda who: {"FLOWEE_URL": url, "FLOWEE_WORKSPACE": "w4", "FLOWEE_AS": who, "FLOWEE_TOKEN": f"w4-{who}", "FLOWEE_CONFIG": str(scratch / "none.toml")},
                   "flowee-gates.json", rw)
        print(f"{c.name} -> {url}/hooks/w4/w4")
        results[c.name] = walk_hooks(c, gh, url, "acme/w4")
    finally:
        if worker:
            worker.terminate()
            worker.wait(timeout=30)
        if rt:
            rt.remove()
        tg.srv.shutdown()
        gh.srv.shutdown()
        gl.srv.shutdown()
        shutil.rmtree(scratch, ignore_errors=True)
    print("wire check:", ", ".join(f"{k} {'passed' if v else 'FAILED'}" for k, v in results.items()))
    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
