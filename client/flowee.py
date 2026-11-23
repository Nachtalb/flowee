#!/usr/bin/env python3
"""Flowee client: one stdlib file, a thin client of the Flowee API (docs/api.md) plus the local git steps.

Remote commands (comments and bodies come on stdin):
  whoami | queue | show N | next | heartbeat N | release N | file TITLE
  developer  handoff N
  tester     pass N [--owner-check] | fail N           (build = HEAD, gates from `flowee.py gates`)
  dev/tester stuck N
  board      triage N | spec N [--title T] | sendback N | rework N | escalate N
             approve N | drop N | postpone N | resume N
  owner      answer N
Local commands:
  gates                 run the gates of .flowee.toml on the working tree, one log per step, stop at the first failure
  commit N MSG [PATH…]  signed one-line commit `MSG (#N)`; refused unless the gates passed on exactly this tree
  push                  fetch origin + signed rebase onto the main branch, push to origin; a rejected push is retried
  busy                  'busy' (exit 2) when uncommitted changes younger than busy_hours exist, else 'idle'

Configuration: .flowee.toml in the repository root (FLOWEE_CONFIG names another file), see docs/api.md.
  url, workspace, instance, secret_file, main_branch, commit_types, ticket_suffix, busy_hours, git_config, [[gates]]
Environment wins over the file: FLOWEE_URL, FLOWEE_WORKSPACE, FLOWEE_AS (instance), FLOWEE_TOKEN (the secret).
Exit: 0 ok, 2 refused, 1 failure, 3 `next` found nothing.
"""
import json, os, re, subprocess, sys, tempfile, time, tomllib, urllib.error, urllib.request, uuid
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


def instance():
    v = os.environ.get("FLOWEE_AS") or setting("instance")
    if not v:
        raise Refused("set FLOWEE_AS or `instance` in .flowee.toml (e.g. board, dev1, tester or owner)")
    return v


def base_url():
    url = os.environ.get("FLOWEE_URL") or setting("url")
    if not url:
        raise Refused("set FLOWEE_URL or `url` in .flowee.toml")
    ws = os.environ.get("FLOWEE_WORKSPACE") or setting("workspace")
    return url.rstrip("/") + (f"/w/{ws}" if ws else "")


def token():
    if v := os.environ.get("FLOWEE_TOKEN"):
        return v.strip()
    tpl = setting("secret_file")
    if not tpl:
        raise Refused("set FLOWEE_TOKEN or `secret_file` in .flowee.toml")
    f = Path(os.path.expanduser(tpl.format(instance=instance(), workspace=setting("workspace", ""))))
    if not f.exists():
        raise Refused(f"missing {f} (or FLOWEE_TOKEN)")
    return f.read_text().strip()


def main_branch():
    return setting("main_branch", "main")


def suffix(n):
    return setting("ticket_suffix", " (#{n})").format(n=n)


def git_config():
    return [x for c in setting("git_config", []) for x in ("-c", c)]


# ---------- remote ----------

def api(method, path, body=None, tries=3):
    """One call; network errors and 5xx are retried with the same idempotency key."""
    url = base_url() + path
    secret = token()
    key = str(uuid.uuid4())
    for attempt in range(tries):
        req = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json",
                                              "User-Agent": f"flowee/{VERSION}", "Idempotency-Key": key})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                d = json.loads(e.read() or b"{}")
            except ValueError:
                d = {}
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
    tag = re.escape(suffix("NUM")).replace("NUM", r"(\d+)")
    m = re.search(tag + "$", msg)
    if m and int(m.group(1)) != n:
        raise Refused(f"the message names #{m.group(1)}, the ticket is #{n}")
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


def cmd_push(tries=3):
    branch = main_branch()
    tag = re.escape(suffix("NUM")).replace("NUM", r"\d+") + "$"
    for attempt in range(tries):
        git(*git_config(), "fetch", "-q", "origin", branch)
        r = subprocess.run(["git", *sign_args(), "rebase", "-q", "-S", "FETCH_HEAD"], capture_output=True, text=True)
        if r.returncode:
            subprocess.run(["git", "rebase", "--abort"], capture_output=True)
            raise Refused(f"rebase onto {branch} conflicts, nothing pushed: {(r.stderr or r.stdout).strip()[:400]}")
        mine = git("log", "--format=%H%x09%G?%x09%s", "FETCH_HEAD..HEAD").splitlines()
        if not mine:
            print("nothing to push")
            return 0
        for line in mine:
            sha, sig, subj = line.split("\t", 2)
            body = git("log", "-1", "--format=%b", sha)
            if sig == "N" or body or not re.search(tag, subj):
                raise Refused(f"{sha[:10]} is unsigned, has a body or lacks '{suffix('N')}': fix it before pushing")
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


# ---------- CLI ----------

def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if argv[0] == "--version":
        print(VERSION)
        return 0
    c, rest = argv[0], argv[1:]
    num = lambda: int(rest[0])
    if c == "gates":
        return cmd_gates()
    if c == "commit":
        return cmd_commit(num(), rest[1], rest[2:])
    if c == "push":
        return cmd_push()
    if c == "busy":
        return cmd_busy()
    if c in ("whoami", "queue"):
        out = api("GET", f"/v1/{c}")
    elif c == "show":
        out = api("GET", f"/v1/show?n={num()}")
    elif c == "next":
        out = api("POST", "/v1/next", {})
        if not out.get("ticket"):
            print("none")
            return 3
    elif c == "heartbeat":
        out = api("POST", "/v1/heartbeat", {"n": num()})
    elif c == "file":
        out = api("POST", "/v1/file", {"title": " ".join(rest), "body": stdin_text()})
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
    elif c in ("release", "handoff", "stuck", "triage", "sendback", "rework", "escalate", "approve", "drop",
               "postpone", "resume"):
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
