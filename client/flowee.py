#!/usr/bin/env python3
"""Flowee client: one stdlib file, a thin client of the Flowee API (docs/api.md) plus the local git steps.

Remote commands (comments and bodies come on stdin):
  whoami | queue | show N | next | heartbeat N | release N | file TITLE [--repo ALIAS]
  N is a ticket: 12, or alias#12 in a workspace with several repositories
  developer  handoff N
  tester     pass N [--owner-check] | fail N           (build = HEAD, gates from `flowee.py gates`)
  dev/tester stuck N
  board      triage N | spec N [--title T] | sendback N | rework N | escalate N
             approve N | drop N | postpone N | resume N
  owner      answer N
  sampler    found N PATH… | unobtainable N                 (feature samples)
  board      triage N [--samples] [PATH…] | needsamples N | checked N
Agents (the project key; `agents add` is idempotent: an agent of that name and role is fine):
  roles                 the agent types this workspace's flow offers: what each does, the states it claims
  agents                the workspace's agents: name, role, last seen, the tickets each holds
  agents add ROLE [NAME]   create one (NAME default: the next free one, dev1, dev2 …); strict mode stores its
                        own secret in secret_file (mode 600) and prints only where
  agents rename OLD NEW | agents pause NAME | agents resume NAME | agents remove NAME
                        (remove: the tickets it holds go back to their queues)
Pull requests (when the workspace's flow has them; the Worker names the branch):
  branch N              switch to the ticket's branch (created from the main branch, or fetched when it exists)
  pr N                  push the ticket's branch and open or update its pull request
  checks N              the pull request's checks: prints green|pending|failed|none; exit 0 green, 3 pending, 2 failed
  merge N               merge it (only where the flow lets the developer merge, e.g. dependency tickets)
Local commands:
  gates                 run the gates of .flowee.toml on the working tree, one log per step, stop at the first failure
  commit N MSG [PATH…]  signed one-line commit `MSG (#N)` (`MSG (alias#N)`); refused unless the gates passed on exactly this tree
  push                  fetch origin + signed rebase onto the main branch, push to origin; a rejected push is retried;
                        on a ticket branch: push that branch (fast-forward only), never the main branch
  busy                  'busy' (exit 2) when uncommitted changes younger than busy_hours exist, else 'idle'
The instance (no secret needed):
  version               this client's and the instance's version; says when the instance serves a newer client
  update                replace this file with the instance's /client/flowee.py (checked to parse; never automatic)

Configuration: .flowee.toml in the repository root (FLOWEE_CONFIG names another file), see docs/api.md.
  url, workspace, key_file (the project key), agent (this clone's agent name), main_branch, commit_types,
  ticket_suffix, busy_hours, git_config, [[gates]]; secret_file (+ instance): an agent with its own secret instead
Environment wins over the file: FLOWEE_URL, FLOWEE_WORKSPACE, FLOWEE_AS (the agent), FLOWEE_TOKEN (key or secret).
Exit: 0 ok, 2 refused, 1 failure, 3 `next` found nothing.
"""
import hashlib, json, os, re, subprocess, sys, tempfile, time, tomllib, urllib.error, urllib.parse, urllib.request, uuid
from pathlib import Path
from typing import Any

VERSION = "0.1.0"
TYPES = ["feat", "fix", "docs", "test", "refactor", "perf", "build", "chore", "style"]


class Refused(Exception):
    pass


# ---------- configuration (read on use, never at import) ----------

_config = None


def config():
    """The .flowee.toml of the repository this runs in (empty when there is none)."""
    global _config
    if _config is None:
        p = os.environ.get("FLOWEE_CONFIG")
        if not p:
            r = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True)
            p = str(Path(r.stdout.strip()) / ".flowee.toml") if r.returncode == 0 else ""
        _config = tomllib.loads(Path(p).read_text()) if p and Path(p).exists() else {}
    return _config


def setting(key, default=None) -> Any:
    return config().get(key, default)


def agent():
    """This clone's agent name (FLOWEE_AS, `agent`, or the former `instance`), or None."""
    return os.environ.get("FLOWEE_AS") or setting("agent") or setting("instance")


def instance():
    v = agent()
    if not v:
        raise Refused("set FLOWEE_AS or `agent` in .flowee.toml (e.g. board, dev1, tester or owner)")
    return v


def base_url():
    url = os.environ.get("FLOWEE_URL") or setting("url")
    if not url:
        raise Refused("set FLOWEE_URL or `url` in .flowee.toml")
    ws = os.environ.get("FLOWEE_WORKSPACE") or setting("workspace")
    return url.rstrip("/") + (f"/w/{ws}" if ws else "")


def secret_path(name):
    tpl = setting("secret_file", "~/.secrets/flowee/{workspace}/{instance}")
    return Path(os.path.expanduser(tpl.format(instance=name, workspace=setting("workspace", ""))))


def token(key=False):
    """The project key (`key_file`), else the agent's own secret (`secret_file`); `key`: the project key only."""
    if v := os.environ.get("FLOWEE_TOKEN"):
        return v.strip()
    f = None
    # an agent's own secret (strict mode, or the former per-agent files) wins over the key for its commands
    if not key and setting("secret_file"):
        f = secret_path(instance())
        if not f.exists() and setting("key_file"):
            f = None
    if f is None:
        if not (tpl := setting("key_file")):
            raise Refused("set FLOWEE_TOKEN or `key_file` (the project key) in .flowee.toml")
        f = Path(os.path.expanduser(tpl.format(workspace=setting("workspace", ""))))
    if not f.exists():
        raise Refused(f"missing {f} (or FLOWEE_TOKEN)")
    return f.read_text().strip()


def main_branch():
    return setting("main_branch", "main")


def ref(text):
    """A ticket: `12`/`#12` (int), or `app#12` in a workspace with several repositories."""
    t = str(text).strip()
    if re.fullmatch(r"#?\d+", t):
        return int(t.lstrip("#"))
    if re.fullmatch(r"[a-z0-9][a-z0-9-]*#\d+", t):
        return t
    raise ValueError(f"{text!r} is no ticket: use 12 or alias#12")


def label(n):
    return n if isinstance(n, str) else f"#{n}"


def suffix(n):
    t = setting("ticket_suffix", " (#{n})")
    return (t.replace("#{n}", "{n}") if isinstance(n, str) else t).format(n=n)


def tag_re():
    """The ticket suffix of any ticket; group 1 is `#7`/`7` or `app#7`."""
    a, b = setting("ticket_suffix", " (#{n})").split("{n}", 1)
    if a.endswith("#"):
        return re.escape(a[:-1]) + r"((?:[a-z0-9][a-z0-9-]*)?#\d+)" + re.escape(b)
    return re.escape(a) + r"((?:[a-z0-9][a-z0-9-]*#)?\d+)" + re.escape(b)


def git_config():
    return [x for c in setting("git_config", []) for x in ("-c", c)]


# ---------- remote ----------

def api(method, path, body=None, tries=3, project=False):
    """One call as this clone's agent (`project`: the project key alone); network errors and 5xx are retried with
    the same idempotency key."""
    url = base_url() + path
    secret = token(project)
    key = str(uuid.uuid4())
    headers = {"Authorization": f"Bearer {secret}", "Content-Type": "application/json",
               "User-Agent": f"flowee/{VERSION}", "Idempotency-Key": key}
    if not project and agent():
        headers["X-Flowee-Agent"] = agent()
    for attempt in range(tries):
        req = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                d = json.loads(e.read() or b"{}")
            except ValueError:
                d = {}
            finally:
                e.close()
            msg = d.get("message") or f"HTTP {e.code}"
            if e.code == 401:
                raise RuntimeError(msg)
            if e.code < 500:
                raise Refused(f"{d.get('error', e.code)}: {msg}")
            if attempt == tries - 1:
                raise RuntimeError(f"{d.get('error', e.code)}: {msg}")
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt == tries - 1:
                raise RuntimeError(f"Flowee unreachable: {e}")
    raise RuntimeError("no attempt made")


def instance_url():
    url = os.environ.get("FLOWEE_URL") or setting("url")
    if not url:
        raise Refused("set FLOWEE_URL or `url` in .flowee.toml")
    return url.rstrip("/")


def fetch(path):
    """GET a public path of the instance (no secret)."""
    req = urllib.request.Request(instance_url() + path, headers={"User-Agent": f"flowee/{VERSION}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{path}: HTTP {e.code}")
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        raise RuntimeError(f"Flowee unreachable: {e}")


def newer(a, b):
    """Whether version a is above version b (numeric parts)."""
    nums = lambda v: [int(x) for x in re.findall(r"\d+", v)]
    return nums(a) > nums(b)


def cmd_version(me=None):
    me = Path(me or __file__).resolve()
    mine = hashlib.sha256(me.read_bytes()).hexdigest()
    print(f"client {VERSION} ({mine[:12]})")
    try:
        v = json.loads(fetch("/version"))
        c = v["client"]
    except (ValueError, KeyError, TypeError):
        raise RuntimeError("the instance answered no version (it predates `GET /version`)")
    print(f"server {v['flowee']} (commit {v['commit']}), serving client {c['version']} ({c['sha256'][:12]})")
    if newer(c["version"], VERSION):
        print(f"the instance serves a newer client: update with `python3 {sys.argv[0] or me} update`")
    elif c["sha256"] != mine:
        print(f"this file differs from the served client; `python3 {sys.argv[0] or me} update` replaces it with the served one")
    else:
        print("up to date")
    return 0


def cmd_update(me=None):
    me = Path(me or __file__).resolve()
    data = fetch("/client/flowee.py")
    try:
        text = data.decode()
        compile(text, "flowee.py", "exec")
    except (UnicodeDecodeError, SyntaxError, ValueError) as e:
        raise Refused(f"the served client does not parse ({e}); {me} is unchanged")
    m = re.search(r'^VERSION = "([^"]+)"', text, re.M)
    if not m:
        raise Refused(f"the served client names no VERSION; {me} is unchanged")
    if data == me.read_bytes():
        print(f"{me} is already the served client {m[1]}")
        return 0
    fd, tmp = tempfile.mkstemp(dir=me.parent, prefix=".flowee-", suffix=".py")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.chmod(tmp, me.stat().st_mode & 0o7777)
    os.replace(tmp, me)
    print(f"updated {me}: {VERSION} -> {m[1]}")
    return 0


def stdin_text():
    return "" if sys.stdin.isatty() else sys.stdin.read().strip()


# ---------- local ----------

def git(*args, cwd=None, check=True, env=None):
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, env=env)
    if check and r.returncode:
        raise Refused(f"git {' '.join(args[:3])}: {(r.stderr or r.stdout).strip()[:400]}")
    return r.stdout.strip()


def tree_id():
    """The tree of the whole working tree (tracked and untracked, minus ignored), without touching the index."""
    with tempfile.TemporaryDirectory() as d:
        env = dict(os.environ, GIT_INDEX_FILE=os.path.join(d, "index"))
        git("read-tree", "HEAD", env=env)
        git("add", "-A", env=env)
        return git("write-tree", env=env)


def gates_file():
    return Path(git("rev-parse", "--git-path", "flowee-gates.json")).resolve()


def steps():
    """[(name, directory, command)] from the [[gates]] tables."""
    return [(g["name"], g.get("dir", "."), g["cmd"]) for g in setting("gates", [])]


def run_gates(steps, logdir):
    """Run each step with its own log; stop at the first failure. -> (ok, failed step or None)."""
    logdir.mkdir(parents=True, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="gates-")
    for name, cwd, cmd in steps:
        log = logdir / f"{name}.log"
        with open(log, "w") as f:
            rc = subprocess.run(cmd, cwd=cwd, stdout=f, stderr=subprocess.STDOUT, env=dict(os.environ, TMPDIR=tmp)).returncode
        print(f"{'ok  ' if rc == 0 else 'FAIL'} {name} ({log})", flush=True)
        if rc:
            print(log.read_text()[-3000:])
            return False, name
    subprocess.run(["rm", "-rf", tmp])
    return True, None


def cmd_gates():
    top = git("rev-parse", "--show-toplevel")
    os.chdir(top)
    if not steps():
        raise Refused("no [[gates]] in .flowee.toml")
    head, tree = git("rev-parse", "HEAD"), tree_id()
    base = Path(os.environ.get("FLOWEE_GATES_LOGS", Path(tempfile.gettempdir()) / "flowee-gates"))
    base.mkdir(parents=True, exist_ok=True)
    logdir = Path(tempfile.mkdtemp(prefix=f"{head[:10]}-", dir=base))
    ok, failed = run_gates(steps(), logdir)
    clean = tree == git("rev-parse", "HEAD^{tree}") and tree_id() == tree
    gates_file().write_text(json.dumps({"sha": head, "tree": tree, "ok": ok, "failed": failed, "clean": clean,
                                        "logs": str(logdir), "at": int(time.time())}))
    print(f"gates: {'OK' if ok else f'FAIL {failed}'} on {head[:10]}{'' if clean else ' + local changes'}")
    return 0 if ok else 1


def last_gates():
    f = gates_file()
    return json.loads(f.read_text()) if f.exists() else {}


def check_message(n, msg):
    msg = msg.strip()
    if "\n" in msg:
        raise Refused("one line only: type(scope): subject")
    m = re.search(tag_re() + "$", msg)
    if m:
        named = m.group(1).lstrip("#")
        # in its own repository a ticket may also be named by its bare number
        if named != str(n) and not (isinstance(n, str) and named == n.split("#")[1]):
            raise Refused(f"the message names {label(ref(named)) if named.isdigit() else named}, the ticket is {label(n)}")
    msg = msg if m else msg + suffix(n)
    types = "|".join(map(re.escape, setting("commit_types", TYPES)))
    if not re.match(rf"^({types})(\([\w./-]+\))?!?: \S.*$", msg):
        raise Refused(f"message must be `type(scope): subject`, type one of {' '.join(setting('commit_types', TYPES))}")
    return msg


def sign_args():
    d = os.environ.get("GPG_STAGE_DIR")
    w = Path(d) / "gpgwrap.sh" if d else None
    return ["-c", f"gpg.program={w}"] if w and w.exists() else []


def cmd_commit(n, msg, paths):
    msg = check_message(n, msg)
    g = last_gates()
    if not g.get("ok") or g.get("tree") != tree_id():
        raise Refused("the gates have not passed on this exact tree: run `flowee.py gates` first")
    if paths:
        git("add", "--", *paths)
    if not git("diff", "--cached", "--name-only"):
        raise Refused("nothing staged")
    git(*sign_args(), "commit", "-q", "-S", "-m", msg)
    if git("log", "-1", "--format=%G?") == "N":
        git("reset", "-q", "--soft", "HEAD~1")
        raise Refused("the commit came out unsigned and was undone: make the signing key available, then retry")
    print(git("log", "-1", "--format=%h %G? %s"))
    return 0


def check_mine(base):
    """The commits base..HEAD: signed, one line, ending with a ticket suffix."""
    mine = git("log", "--format=%H%x09%G?%x09%s", f"{base}..HEAD").splitlines()
    for line in mine:
        sha, sig, subj = line.split("\t", 2)
        body = git("log", "-1", "--format=%b", sha)
        if sig == "N" or body or not re.search(tag_re() + "$", subj):
            raise Refused(f"{sha[:10]} is unsigned, has a body or lacks '{suffix('N')}': fix it before pushing")
    return mine


def push_branch(branch):
    """Pushes HEAD to the ticket's branch on origin, fast-forward only."""
    git(*git_config(), "fetch", "-q", "origin", main_branch())
    mine = check_mine("FETCH_HEAD")
    if not mine:
        raise Refused(f"no commit on {branch} beyond {main_branch()}: commit first")
    r = subprocess.run(["git", *git_config(), "push", "-q", "origin", f"HEAD:refs/heads/{branch}"], capture_output=True, text=True)
    if r.returncode:
        raise Refused(f"push of {branch} refused: {r.stderr.strip()[:400]}")
    print(f"pushed {branch} at {git('rev-parse', '--short', 'HEAD')}", file=sys.stderr)


def ticket_branch(n):
    """The ticket's branch as the Worker names it; refused when the workspace's flow has no pull requests."""
    b = api("GET", f"/v1/show?n={urllib.parse.quote(str(n))}").get("branch")
    if not b:
        raise Refused("this workspace's flow has no pull requests: work on the main branch")
    return b


def cmd_branch(n):
    b = ticket_branch(n)
    if git("rev-parse", "-q", "--verify", f"refs/heads/{b}", check=False):
        git("switch", "-q", b)
    else:
        remote = git(*git_config(), "ls-remote", "--heads", "origin", b, check=False)
        git(*git_config(), "fetch", "-q", "origin", b if remote else main_branch())
        git("switch", "-q", "-c", b, "FETCH_HEAD")
    print(b)
    return 0


def cmd_pr(n):
    b = ticket_branch(n)
    if git("rev-parse", "--abbrev-ref", "HEAD") != b:
        raise Refused(f"switch to {b} first: flowee.py branch {label(n)}")
    push_branch(b)
    out = api("POST", "/v1/pr", {"n": n})
    out.pop("ok", None)
    print(json.dumps(out))
    return 0


def cmd_checks(n):
    pull = api("GET", f"/v1/show?n={urllib.parse.quote(str(n))}").get("pull")
    if not pull:
        raise Refused(f"{label(n)} has no pull request yet: flowee.py pr {label(n)}")
    state = pull.get("checks") or pull.get("state")
    print(state + (f": {pull['waiting']}" if pull.get("waiting") else ""))
    return {"green": 0, "merged": 0, "failed": 2}.get(state, 3)


def cmd_push(tries=3):
    branch = main_branch()
    current = git("rev-parse", "--abbrev-ref", "HEAD")
    if current not in (branch, "HEAD"):
        push_branch(current)
        return 0
    for attempt in range(tries):
        git(*git_config(), "fetch", "-q", "origin", branch)
        r = subprocess.run(["git", *sign_args(), "rebase", "-q", "-S", "FETCH_HEAD"], capture_output=True, text=True)
        if r.returncode:
            subprocess.run(["git", "rebase", "--abort"], capture_output=True)
            raise Refused(f"rebase onto {branch} conflicts, nothing pushed: {(r.stderr or r.stdout).strip()[:400]}")
        mine = check_mine("FETCH_HEAD")
        if not mine:
            print("nothing to push")
            return 0
        r = subprocess.run(["git", *git_config(), "push", "-q", "origin", f"HEAD:{branch}"], capture_output=True, text=True)
        if r.returncode == 0:
            print(f"pushed {len(mine)} commit(s), {branch} is {git('rev-parse', '--short', 'HEAD')}")
            return 0
        if not re.search(r"rejected|fetch first|non-fast-forward", r.stderr):
            raise RuntimeError(f"push failed: {r.stderr.strip()[:400]}")
        print(f"push rejected ({branch} moved), rebasing again ({attempt + 1}/{tries})", file=sys.stderr)
    raise RuntimeError("push rejected three times")


def cmd_busy(now=None):
    now = now or time.time()
    limit = float(setting("busy_hours", 2)) * 3600
    top = Path(git("rev-parse", "--show-toplevel"))
    young = []
    st = subprocess.run(["git", "status", "--porcelain", "-z", "--untracked-files=all"], capture_output=True, text=True)
    for entry in st.stdout.split("\0"):
        p = top / entry[3:] if len(entry) > 3 else None
        if p and p.exists() and now - p.stat().st_mtime < limit:
            young.append((entry[3:], int((now - p.stat().st_mtime) // 60)))
    if young:
        print("busy: " + ", ".join(f"{f} ({m} min)" for f, m in young[:5]))
        return 2
    print("idle")
    return 0


# ---------- agents (the project key) ----------

def cmd_roles(raw=False):
    out = api("GET", "/v1/roles", project=True)
    if raw:
        print(json.dumps(out["roles"]))
        return 0
    for r in out["roles"]:
        print(f"{r['name']} ({'several' if r['several'] else 'one'}): {r['description']}")
        print(f"  claims: {', '.join(r['claims']) or 'nothing (no queue)'}")
        print(f"  commands: {', '.join(r['commands'])}")
    return 0


def cmd_agents(rest):
    sub, args = (rest[0], rest[1:]) if rest else ("list", [])
    if sub in ("list", "--json"):
        out = api("GET", "/v1/agents", project=True)
        if sub == "--json" or "--json" in args:
            print(json.dumps(out["agents"]))
            return 0
        for a in out["agents"]:
            held = ", ".join(label(n) for n in a["holds"]) or "nothing"
            state = "paused, " if a["paused"] else ""
            print(f"{a['name']}  {a['role']}  {state}seen {a.get('seen', 'never')}  holds {held}")
        if not out["agents"]:
            print("no agents yet: `flowee.py roles`, then `flowee.py agents add ROLE`")
        return 0
    if sub == "add":
        body = {"role": args[0], **({"name": args[1]} if len(args) > 1 else {})}
        try:
            out = api("POST", "/v1/agents", body, project=True)
        except Refused as e:
            # idempotent: the agent exists with that role already (a scheduler's first run, every run)
            if len(args) > 1 and str(e).startswith("name_taken:"):
                have = api("GET", f"/v1/agents/{args[1]}", project=True)["agent"]
                if have["role"] == args[0]:
                    print(json.dumps({"agent": have, "existed": True}))
                    return 0
            raise
        if s := out.pop("secret", None):
            f = secret_path(out["agent"]["name"])
            f.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with open(os.open(f, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as fh:
                fh.write(s + "\n")
            out["secret_file"] = str(f)
        out.pop("ok", None)
        print(json.dumps(out))
        return 0
    if sub in ("rename", "pause", "resume", "remove"):
        name = args[0]
        if sub == "remove":
            out = api("DELETE", f"/v1/agents/{name}", project=True)
        else:
            out = api("PATCH", f"/v1/agents/{name}", {"name": args[1]} if sub == "rename" else {"paused": sub == "pause"}, project=True)
        out.pop("ok", None)
        print(json.dumps(out))
        return 0
    raise Refused(f"unknown agents command {sub}; see --help")


# ---------- CLI ----------

def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if argv[0] == "--version":
        print(VERSION)
        return 0
    c, rest = argv[0], argv[1:]
    num = lambda: ref(rest[0])
    if c == "gates":
        return cmd_gates()
    if c == "commit":
        return cmd_commit(num(), rest[1], rest[2:])
    if c == "push":
        return cmd_push()
    if c == "busy":
        return cmd_busy()
    if c in ("version", "update"):
        return cmd_version() if c == "version" else cmd_update()
    if c == "roles":
        return cmd_roles("--json" in rest)
    if c == "agents":
        return cmd_agents(rest)
    if c in ("branch", "pr", "checks"):
        return {"branch": cmd_branch, "pr": cmd_pr, "checks": cmd_checks}[c](num())
    if c in ("whoami", "queue"):
        out = api("GET", f"/v1/{c}")
    elif c == "show":
        out = api("GET", f"/v1/show?n={urllib.parse.quote(str(num()))}")
    elif c == "next":
        out = api("POST", "/v1/next", {})
        if not out.get("ticket"):
            print("none")
            return 3
    elif c == "heartbeat":
        out = api("POST", "/v1/heartbeat", {"n": num()})
    elif c == "file":
        body = {"title": " ".join(x for i, x in enumerate(rest) if x != "--repo" and (i == 0 or rest[i - 1] != "--repo")), "body": stdin_text()}
        if "--repo" in rest:
            body["repo"] = rest[rest.index("--repo") + 1]
        out = api("POST", "/v1/file", body)
    elif c == "answer":
        out = api("POST", "/v1/answer", {"n": num(), "text": stdin_text()})
    elif c == "spec":
        body = {"n": num(), "body": stdin_text()}
        if "--title" in rest:
            body["title"] = rest[rest.index("--title") + 1]
        out = api("POST", "/v1/spec", body)
    elif c in ("pass", "fail"):
        head = git("rev-parse", "HEAD")
        body = {"n": num(), "comment": stdin_text(), "build": head}
        if c == "pass":
            g = last_gates()
            if not (g.get("ok") and g.get("clean") and g.get("sha") == head):
                raise Refused("pass needs green gates on a clean HEAD: run `flowee.py gates` first")
            body |= {"gates": {"sha": g["sha"], "ok": True}, "owner_check": "--owner-check" in rest}
        out = api("POST", f"/v1/{c}", body)
    elif c in ("found", "triage"):
        body = {"n": num(), "comment": stdin_text(), "paths": [x for x in rest[1:] if not x.startswith("--")]}
        if c == "triage":
            body["samples"] = "--samples" in rest
        out = api("POST", f"/v1/{c}", body)
    elif c == "merge":
        out = api("POST", "/v1/merge", {"n": num()})
    elif c in ("release", "handoff", "stuck", "sendback", "rework", "escalate", "approve", "drop",
               "postpone", "resume", "unobtainable", "needsamples", "checked"):
        out = api("POST", f"/v1/{c}", {"n": num(), "comment": stdin_text()})
    else:
        raise Refused(f"unknown command {c}; see --help")
    out.pop("ok", None)
    print(json.dumps(out))
    return 0


def run(argv):
    try:
        return main(argv)
    except Refused as e:
        print(f"refused: {e}", file=sys.stderr)
        return 2
    except (RuntimeError, IndexError, ValueError, tomllib.TOMLDecodeError) as e:
        print(f"failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
