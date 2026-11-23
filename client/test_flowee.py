#!/usr/bin/env python3
"""Tests for client/flowee.py: the remote commands against a local stand-in server, the local commit / push /
gates / busy steps in scratch repos only (each one's `origin` is asserted to be a scratch bare repo first)."""
import contextlib, io, json, os, re, shutil, socket, subprocess, sys, tempfile, threading, unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.dont_write_bytecode = True
import flowee  # noqa: E402


class Server:
    """Answers each request from `replies` (path -> list of (status, body)); records what it got."""

    def __init__(self):
        self.got, self.replies = [], {}
        me = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def go(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                me.got.append({"method": self.command, "path": self.path, "headers": dict(self.headers),
                               "body": json.loads(raw) if raw else None})
                q = me.replies.get(self.path.split("?")[0], [(200, {"ok": True})])
                status, body = q.pop(0) if len(q) > 1 else q[0]
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PATCH = do_DELETE = go

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_port}"


def call(*argv, stdin=""):
    out, err = io.StringIO(), io.StringIO()
    old = sys.stdin
    sys.stdin = io.StringIO(stdin)
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = flowee.run(list(argv))
    finally:
        sys.stdin = old
    return rc, out.getvalue().strip(), err.getvalue().strip()


class Remote(unittest.TestCase):
    def setUp(self):
        self.s = Server()
        self.d = Path(tempfile.mkdtemp(prefix="flowee-remote-"))
        self.env = dict(os.environ)
        cfg = self.d / ".flowee.toml"
        (self.d / "secret-dev1").write_text("s-dev1\n")
        cfg.write_text(f'url = "{self.s.url}"\nworkspace = "acme"\ninstance = "dev1"\nsecret_file = "{self.d}/secret-{{instance}}"\n')
        for k in ("FLOWEE_URL", "FLOWEE_AS", "FLOWEE_TOKEN", "FLOWEE_WORKSPACE"):
            os.environ.pop(k, None)
        os.environ["FLOWEE_CONFIG"] = str(cfg)
        flowee._config = None
        self.saved = flowee.git, flowee.last_gates

    def tearDown(self):
        flowee.git, flowee.last_gates = self.saved
        os.environ.clear()
        os.environ.update(self.env)
        flowee._config = None
        self.s.srv.shutdown()
        self.s.srv.server_close()
        shutil.rmtree(self.d, ignore_errors=True)

    def test_url_workspace_secret_and_user_agent_come_from_the_config(self):
        self.s.replies["/w/acme/v1/whoami"] = [(200, {"ok": True, "instance": "dev1", "role": "developer"})]
        rc, out, _ = call("whoami")
        self.assertEqual((rc, json.loads(out)), (0, {"instance": "dev1", "role": "developer"}))
        h = self.s.got[0]["headers"]
        self.assertEqual(h["Authorization"], "Bearer s-dev1")
        self.assertEqual(h["User-Agent"], f"flowee/{flowee.VERSION}")
        os.environ.update(FLOWEE_TOKEN="other", FLOWEE_WORKSPACE="beta")
        call("whoami")
        self.assertEqual((self.s.got[1]["path"], self.s.got[1]["headers"]["Authorization"]), ("/w/beta/v1/whoami", "Bearer other"))

    def key_clone(self, strict=False):
        """A clone set up the new way: url, workspace, the project key's file, the agent's name."""
        (self.d / "key").write_text("k-acme\n")
        extra = f'secret_file = "{self.d}/own/{{instance}}"\n' if strict else ""
        (self.d / ".flowee.toml").write_text(f'url = "{self.s.url}"\nworkspace = "acme"\nkey_file = "{self.d}/key"\nagent = "dev2"\n{extra}')
        flowee._config = None

    def test_the_project_key_acts_as_the_named_agent(self):
        self.key_clone()
        self.s.replies["/w/acme/v1/next"] = [(200, {"ok": True, "ticket": {"n": 4}})]
        rc, out, _ = call("next")
        self.assertEqual((rc, out), (0, '{"ticket": {"n": 4}}'))
        g = self.s.got[-1]
        self.assertEqual((g["headers"]["Authorization"], g["headers"]["X-Flowee-Agent"]), ("Bearer k-acme", "dev2"))
        os.environ["FLOWEE_AS"] = "tester"
        call("whoami")
        self.assertEqual(self.s.got[-1]["headers"]["X-Flowee-Agent"], "tester")
        self.s.replies["/w/acme/v1/next"] = [(403, {"ok": False, "error": "unknown_agent", "message": "There is no agent 'tester'; create it with `flowee.py agents add <role> tester`."})]
        rc, _, err = call("next")
        self.assertEqual((rc, err), (2, "refused: unknown_agent: There is no agent 'tester'; create it with `flowee.py agents add <role> tester`."))

    def test_roles_and_agents(self):
        self.key_clone()
        self.s.replies["/w/acme/v1/roles"] = [(200, {"ok": True, "roles": [
            {"name": "developer", "description": "Builds what a ready ticket asks for.", "commands": ["next", "handoff"], "claims": ["ready"], "several": True},
            {"name": "owner", "description": "Relays the owner's answers.", "commands": ["answer"], "claims": [], "several": False}]})]
        rc, out, _ = call("roles")
        self.assertEqual(rc, 0)
        self.assertEqual(out.splitlines(), ["developer (several): Builds what a ready ticket asks for.", "  claims: ready", "  commands: next, handoff",
                                            "owner (one): Relays the owner's answers.", "  claims: nothing (no queue)", "  commands: answer"])
        self.assertNotIn("X-Flowee-Agent", self.s.got[-1]["headers"])
        self.s.replies["/w/acme/v1/agents"] = [(200, {"ok": True, "secrets": "project", "agents": [
            {"name": "dev1", "role": "developer", "source": "api", "paused": False, "seen": "2026-11-23T10:00:00.000Z", "holds": [12]},
            {"name": "dev2", "role": "developer", "source": "api", "paused": True, "holds": []}]})]
        rc, out, _ = call("agents")
        self.assertEqual(out.splitlines(), ["dev1  developer  seen 2026-11-23T10:00:00.000Z  holds #12", "dev2  developer  paused, seen never  holds nothing"])
        self.s.replies["/w/acme/v1/agents"] = [(200, {"ok": True, "agent": {"name": "dev3", "role": "developer"}})]
        self.assertEqual(call("agents", "add", "developer")[:2], (0, '{"agent": {"name": "dev3", "role": "developer"}}'))
        self.assertEqual((self.s.got[-1]["method"], self.s.got[-1]["body"]), ("POST", {"role": "developer"}))
        call("agents", "rename", "dev3", "ada")
        self.assertEqual((self.s.got[-1]["method"], self.s.got[-1]["path"], self.s.got[-1]["body"]), ("PATCH", "/w/acme/v1/agents/dev3", {"name": "ada"}))
        call("agents", "pause", "ada")
        self.assertEqual(self.s.got[-1]["body"], {"paused": True})
        call("agents", "resume", "ada")
        self.assertEqual(self.s.got[-1]["body"], {"paused": False})
        call("agents", "remove", "ada")
        self.assertEqual((self.s.got[-1]["method"], self.s.got[-1]["path"]), ("DELETE", "/w/acme/v1/agents/ada"))

    def test_agents_add_is_idempotent_for_the_same_role(self):
        self.key_clone()
        taken = (409, {"ok": False, "error": "name_taken", "message": "The name 'dev1' is taken; choose another or leave the name out."})
        self.s.replies["/w/acme/v1/agents"] = [taken]
        self.s.replies["/w/acme/v1/agents/dev1"] = [(200, {"ok": True, "agent": {"name": "dev1", "role": "developer"}})]
        self.assertEqual(call("agents", "add", "developer", "dev1")[:2], (0, '{"agent": {"name": "dev1", "role": "developer"}, "existed": true}'))
        rc, _, err = call("agents", "add", "tester", "dev1")
        self.assertEqual((rc, err), (2, "refused: name_taken: The name 'dev1' is taken; choose another or leave the name out."))

    def test_strict_mode_stores_the_agents_own_secret_and_signs_in_with_it(self):
        self.key_clone(strict=True)
        self.s.replies["/w/acme/v1/agents"] = [(200, {"ok": True, "agent": {"name": "dev2", "role": "developer"}, "secret": "own-dev2"})]
        rc, out, _ = call("agents", "add", "developer", "dev2")
        f = self.d / "own" / "dev2"
        self.assertEqual((rc, json.loads(out)["secret_file"]), (0, str(f)))
        self.assertNotIn("own-dev2", out)
        self.assertEqual((f.read_text(), oct(f.stat().st_mode & 0o777)), ("own-dev2\n", "0o600"))
        call("whoami")
        self.assertEqual(self.s.got[-1]["headers"]["Authorization"], "Bearer own-dev2")
        self.s.replies["/w/acme/v1/agents"] = [(200, {"ok": True, "secrets": "per-agent", "agents": []})]
        call("agents")
        self.assertEqual(self.s.got[-1]["headers"]["Authorization"], "Bearer k-acme")

    def test_bodies_match_the_api(self):
        flowee.git = lambda *a, **k: "b" * 40
        flowee.last_gates = lambda: {"ok": True, "clean": True, "sha": "b" * 40}
        call("file", "A", "title", stdin="body text")
        call("spec", "3", "--title", "New", stdin="new body")
        call("pass", "3", "--owner-check", stdin="looks right")
        call("fail", "3", stdin="seen x")
        call("answer", "3", stdin="blue")
        call("escalate", "3", stdin="card")
        call("show", "3")
        call("show", "lib#3")
        call("file", "B", "--repo", "lib", stdin="b")
        self.assertEqual([(g["method"], g["path"], g["body"]) for g in self.s.got], [
            ("POST", "/w/acme/v1/file", {"title": "A title", "body": "body text"}),
            ("POST", "/w/acme/v1/spec", {"n": 3, "body": "new body", "title": "New"}),
            ("POST", "/w/acme/v1/pass", {"n": 3, "comment": "looks right", "build": "b" * 40, "gates": {"sha": "b" * 40, "ok": True}, "owner_check": True}),
            ("POST", "/w/acme/v1/fail", {"n": 3, "comment": "seen x", "build": "b" * 40}),
            ("POST", "/w/acme/v1/answer", {"n": 3, "text": "blue"}),
            ("POST", "/w/acme/v1/escalate", {"n": 3, "comment": "card"}),
            ("GET", "/w/acme/v1/show?n=3", None),
            ("GET", "/w/acme/v1/show?n=lib%233", None),
            ("POST", "/w/acme/v1/file", {"title": "B", "body": "b", "repo": "lib"}),
        ])

    def test_pass_needs_green_gates_on_a_clean_head(self):
        flowee.git = lambda *a, **k: "b" * 40
        flowee.last_gates = lambda: {"ok": True, "clean": True, "sha": "a" * 40}
        rc, _, err = call("pass", "3", stdin="ok")
        self.assertEqual(rc, 2)
        self.assertIn("green gates", err)
        self.assertEqual(self.s.got, [])

    def test_retries_5xx_with_the_same_idempotency_key(self):
        self.s.replies["/w/acme/v1/approve"] = [(502, {"ok": False, "error": "github", "message": "x"}), (200, {"ok": True, "state": "closed"})]
        rc, out, _ = call("approve", "4")
        self.assertEqual((rc, json.loads(out)), (0, {"state": "closed"}))
        keys = {g["headers"]["Idempotency-Key"] for g in self.s.got}
        self.assertEqual((len(self.s.got), len(keys)), (2, 1))

    def test_exit_codes(self):
        self.s.replies["/w/acme/v1/next"] = [(200, {"ok": True, "ticket": None})]
        self.assertEqual(call("next"), (3, "none", ""))
        self.s.replies["/w/acme/v1/triage"] = [(403, {"ok": False, "error": "wrong_role", "message": "Only the board may use triage."})]
        rc, _, err = call("triage", "1", stdin="go")
        self.assertEqual((rc, err), (2, "refused: wrong_role: Only the board may use triage."))
        self.s.replies["/w/acme/v1/whoami"] = [(401, {"ok": False, "error": "unauthorized", "message": "Unknown or missing token."})]
        self.assertEqual(call("whoami")[0], 1)
        self.assertEqual(call("frobnicate")[0], 2)

    def test_exit_codes_from_a_real_process(self):
        env = dict(os.environ, FLOWEE_AS="dev1")
        run = lambda *a: subprocess.run([sys.executable, str(HERE / "flowee.py"), *a], env=env, capture_output=True, text=True, stdin=subprocess.DEVNULL)
        self.s.replies["/w/acme/v1/next"] = [(200, {"ok": True, "ticket": None})]
        self.assertEqual(run("next").returncode, 3)
        with socket.socket() as s:  # a port nobody listens on
            s.bind(("127.0.0.1", 0))
            env["FLOWEE_URL"] = f"http://127.0.0.1:{s.getsockname()[1]}"
        self.assertEqual(run("whoami").returncode, 1)
        env.pop("FLOWEE_URL")
        env["FLOWEE_CONFIG"] = str(self.d / "missing.toml")
        r = run("whoami")
        self.assertEqual((r.returncode, r.stderr.strip()), (2, "refused: set FLOWEE_URL or `url` in .flowee.toml"))


class SelfCheck(Remote):
    """`version` and `update` against the instance's GET /version and /client/flowee.py, on a copy of the client."""

    def copy(self):
        me = self.d / "flowee.py"
        shutil.copy(HERE / "flowee.py", me)
        return me

    def served(self, version, data):
        import hashlib
        self.s.replies["/version"] = [(200, {"ok": True, "flowee": "9.9.9", "commit": "abc123def456",
                                             "client": {"version": version, "sha256": hashlib.sha256(data).hexdigest()}})]
        self.s.replies["/client/flowee.py"] = [(200, data)]

    def test_version_says_up_to_date_newer_or_differs(self):
        me = self.copy()
        self.served(flowee.VERSION, me.read_bytes())
        rc, out, _ = call("version")
        lines = out.splitlines()
        self.assertEqual(rc, 0)
        self.assertRegex(lines[0], rf"^client {re.escape(flowee.VERSION)} \([0-9a-f]{{12}}\)$")
        self.assertEqual(lines[1:], [f"server 9.9.9 (commit abc123def456), serving client {flowee.VERSION} ({lines[0][-13:-1]})", "up to date"])
        self.assertNotIn("Authorization", self.s.got[-1]["headers"])
        self.assertEqual(self.s.got[-1]["path"], "/version")
        self.served("99.0.0", b"VERSION = \"99.0.0\"\n")
        self.assertIn("the instance serves a newer client: update with `python3 ", call("version")[1])
        self.served(flowee.VERSION, b"VERSION = \"0.0.1\"\n")
        self.assertIn("this file differs from the served client", call("version")[1])
        self.s.replies["/version"] = [(404, {"ok": False})]
        self.assertEqual(call("version")[0], 1)

    def test_update_replaces_the_file_only_with_a_client_that_parses(self):
        me = self.copy()
        run = lambda: subprocess.run([sys.executable, str(me), "update"], env=dict(os.environ), capture_output=True, text=True)
        before = me.read_bytes()
        self.served("99.0.0", b"def broken(:\n")
        r = run()
        self.assertEqual(r.returncode, 2)
        self.assertIn("refused: the served client does not parse", r.stderr)
        self.assertEqual(me.read_bytes(), before)
        new = before.replace(f'VERSION = "{flowee.VERSION}"'.encode(), b'VERSION = "99.0.0"')
        self.served("99.0.0", new)
        r = run()
        self.assertEqual((r.returncode, r.stdout.strip()), (0, f"updated {me}: {flowee.VERSION} -> 99.0.0"))
        self.assertEqual(me.read_bytes(), new)
        self.assertEqual(oct(me.stat().st_mode & 0o777), oct((HERE / "flowee.py").stat().st_mode & 0o777))
        self.assertEqual([p.name for p in self.d.glob(".flowee-*")], [])
        self.assertIn("is already the served client 99.0.0", run().stdout)


class Local(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp(prefix="flowee-local-"))
        flowee._config = {}

    def tearDown(self):
        flowee._config = None
        shutil.rmtree(self.d, ignore_errors=True)

    def test_message_rules(self):
        self.assertEqual(flowee.check_message(7, "fix(web): x"), "fix(web): x (#7)")
        self.assertEqual(flowee.check_message(7, "fix(web): x (#7)"), "fix(web): x (#7)")
        for bad in ("fix(web): x (#8)", "fixed stuff", "fix(web): a\nb", "feat:x", "wip(web): x"):
            with self.assertRaises(flowee.Refused):
                flowee.check_message(7, bad)
        flowee._config = {"commit_types": ["wip"], "ticket_suffix": " [GH-{n}]"}
        self.assertEqual(flowee.check_message(7, "wip(web): x"), "wip(web): x [GH-7]")
        with self.assertRaises(flowee.Refused):
            flowee.check_message(7, "wip: x [GH-8]")

    def test_alias_tickets_of_several_repositories(self):
        flowee._config = {}
        self.assertEqual([flowee.ref(x) for x in ("7", "#7", "app#7")], [7, 7, "app#7"])
        with self.assertRaises(ValueError):
            flowee.ref("App#7")
        self.assertEqual(flowee.check_message("app#7", "fix(web): x"), "fix(web): x (app#7)")
        self.assertEqual(flowee.check_message("app#7", "fix(web): x (#7)"), "fix(web): x (#7)")
        self.assertEqual(flowee.check_message("app#7", "fix(web): x (app#7)"), "fix(web): x (app#7)")
        for bad in ("fix(web): x (lib#7)", "fix(web): x (#8)"):
            with self.assertRaises(flowee.Refused):
                flowee.check_message("app#7", bad)
        with self.assertRaises(flowee.Refused):
            flowee.check_message(7, "fix(web): x (app#7)")

    def test_gates_stop_at_the_first_failure_with_one_log_each(self):
        steps = [("one", ".", ["true"]), ("two", ".", ["sh", "-c", "echo boom; exit 3"]), ("three", ".", ["true"])]
        with contextlib.redirect_stdout(io.StringIO()):
            ok, failed = flowee.run_gates(steps, self.d / "logs")
        self.assertEqual((ok, failed), (False, "two"))
        self.assertEqual(sorted(p.name for p in (self.d / "logs").iterdir()), ["one.log", "two.log"])
        self.assertIn("boom", (self.d / "logs/two.log").read_text())


@unittest.skipUnless(shutil.which("gpg"), "gpg missing")
class FeatureCommands(Remote):
    """Samples, untrusted text and pull request commands send what the API expects."""

    def test_feature_bodies(self):
        call("found", "4", "Samples/a.qoi", "Samples/b.qoi", stdin="got them")
        call("triage", "4", "--samples", stdin="needs one")
        call("triage", "4", "Samples/a.qoi", stdin="ready")
        call("unobtainable", "4", stdin="### For the owner")
        call("checked", "4", stdin="nothing new")
        call("merge", "4")
        self.assertEqual([(g["path"], g["body"]) for g in self.s.got], [
            ("/w/acme/v1/found", {"n": 4, "comment": "got them", "paths": ["Samples/a.qoi", "Samples/b.qoi"]}),
            ("/w/acme/v1/triage", {"n": 4, "comment": "needs one", "paths": [], "samples": True}),
            ("/w/acme/v1/triage", {"n": 4, "comment": "ready", "paths": ["Samples/a.qoi"], "samples": False}),
            ("/w/acme/v1/unobtainable", {"n": 4, "comment": "### For the owner"}),
            ("/w/acme/v1/checked", {"n": 4, "comment": "nothing new"}),
            ("/w/acme/v1/merge", {"n": 4}),
        ])

    def test_checks_exit_codes_wait_on_pending(self):
        for pull, rc, text in (({"state": "open", "checks": "green"}, 0, "green"), ({"state": "open", "checks": "pending", "waiting": "build (in progress)"}, 3, "pending: build (in progress)"),
                               ({"state": "open", "checks": "failed"}, 2, "failed"), ({"state": "merged"}, 0, "merged")):
            self.s.replies["/w/acme/v1/show"] = [(200, {"ok": True, "pull": pull})]
            self.assertEqual(call("checks", "4")[:2], (rc, text))
        self.s.replies["/w/acme/v1/show"] = [(200, {"ok": True, "pull": None})]
        self.assertEqual(call("checks", "4")[0], 2)

    def test_branch_commands_need_a_flow_with_pull_requests(self):
        self.s.replies["/w/acme/v1/show"] = [(200, {"ok": True, "state": "in development"})]
        rc, _, err = call("branch", "4")
        self.assertEqual((rc, err), (2, "refused: this workspace's flow has no pull requests: work on the main branch"))


class GitSteps(unittest.TestCase):
    """commit, push with a rejected-push retry, gates, busy: real git and a throwaway gpg key, in scratch repos."""

    def setUp(self):
        self.d = Path(tempfile.mkdtemp(prefix="flowee-git-"))
        self.cwd, self.env = os.getcwd(), dict(os.environ)
        gh = self.d / "gnupg"
        gh.mkdir(mode=0o700)
        os.environ.update(GNUPGHOME=str(gh), GIT_CONFIG_GLOBAL=str(self.d / "gitconfig"), GIT_CONFIG_NOSYSTEM="1")
        for k in ("GPG_STAGE_DIR", "FLOWEE_CONFIG"):
            os.environ.pop(k, None)
        subprocess.run(["gpg", "--batch", "--passphrase", "", "--quick-gen-key", "T <t@example.org>", "ed25519", "sign", "never"],
                       check=True, capture_output=True)
        for k, v in (("user.name", "T"), ("user.email", "t@example.org"), ("user.signingkey", "t@example.org"), ("init.defaultBranch", "main")):
            subprocess.run(["git", "config", "--global", k, v], check=True)
        g = lambda *a, cwd=None: subprocess.run(["git", *a], cwd=cwd, check=True, capture_output=True, text=True).stdout
        self.g = g
        g("init", "-q", "--bare", str(self.d / "origin.git"))
        g("clone", "-q", str(self.d / "origin.git"), str(self.d / "a"))
        # the client pushes to `origin`: before anything else runs, it must be this scratch bare repo
        assert g("remote", "get-url", "origin", cwd=self.d / "a").strip() == str(self.d / "origin.git")
        (self.d / "a/f").write_text("1\n")
        (self.d / "a/.flowee.toml").write_text('main_branch = "main"\n[[gates]]\nname = "one"\ncmd = ["true"]\n')
        g("add", "f", ".flowee.toml", cwd=self.d / "a")
        g("commit", "-q", "-S", "-m", "chore(x): start (#1)", cwd=self.d / "a")
        g("push", "-q", "origin", "HEAD:main", cwd=self.d / "a")
        g("clone", "-q", str(self.d / "origin.git"), str(self.d / "b"))
        for c in ("a", "b"):
            url = g("remote", "get-url", "origin", cwd=self.d / c).strip()
            assert url == str(self.d / "origin.git"), url
        self.real_git = flowee.git
        flowee._config = None

    def tearDown(self):
        os.chdir(self.cwd)
        os.environ.clear()
        os.environ.update(self.env)
        flowee.git = self.real_git
        flowee._config = None
        shutil.rmtree(self.d, ignore_errors=True)

    def green(self):
        flowee.gates_file().write_text(json.dumps({"ok": True, "tree": flowee.tree_id()}))

    def test_commit_needs_green_gates_on_this_tree_then_signs(self):
        os.chdir(self.d / "a")
        (self.d / "a/f").write_text("2\n")
        with self.assertRaises(flowee.Refused):
            flowee.cmd_commit(5, "fix(x): two", ["f"])
        self.green()
        (self.d / "a/g").write_text("changed after the gates\n")
        with self.assertRaises(flowee.Refused):
            flowee.cmd_commit(5, "fix(x): two", ["f"])
        os.remove(self.d / "a/g")
        with contextlib.redirect_stdout(io.StringIO()):
            flowee.cmd_commit(5, "fix(x): two", ["f"])
        self.assertEqual(self.g("log", "-1", "--format=%s", cwd=self.d / "a").strip(), "fix(x): two (#5)")
        self.assertNotEqual(self.g("log", "-1", "--format=%G?", cwd=self.d / "a").strip(), "N")

    def test_push_rebases_and_retries_a_rejected_push(self):
        os.chdir(self.d / "b")
        (self.d / "b/h").write_text("b\n")
        self.green()
        with contextlib.redirect_stdout(io.StringIO()):
            flowee.cmd_commit(6, "feat(x): from b", ["h"])
        real, pushed = flowee.git, []

        def git(*a, **k):
            out = real(*a, **k)
            if "fetch" in a and not pushed:  # another agent pushes between our fetch and our push
                pushed.append(1)
                (self.d / "a/f").write_text("from a\n")
                self.g("commit", "-q", "-S", "-am", "fix(x): from a (#2)", cwd=self.d / "a")
                self.g("push", "-q", "origin", "HEAD:main", cwd=self.d / "a")
            return out

        flowee.git = git
        err = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
            self.assertEqual(flowee.cmd_push(), 0)
        self.assertIn("push rejected", err.getvalue())
        log = self.g("log", "--format=%G? %s", "main", cwd=self.d / "origin.git").splitlines()
        self.assertEqual([x[2:] for x in log], ["feat(x): from b (#6)", "fix(x): from a (#2)", "chore(x): start (#1)"])
        self.assertTrue(all(x[0] != "N" for x in log), log)

    def test_branch_pr_and_push_stay_on_the_ticket_branch(self):
        s = Server()
        try:
            os.chdir(self.d / "a")
            (self.d / "a/.flowee.toml").write_text(f'url = "{s.url}"\ninstance = "dev1"\nmain_branch = "main"\n[[gates]]\nname = "one"\ncmd = ["true"]\n')
            os.environ["FLOWEE_TOKEN"] = "t"
            flowee._config = None
            s.replies["/v1/show"] = [(200, {"ok": True, "branch": "flowee/5"})]
            s.replies["/v1/pr"] = [(200, {"ok": True, "pull": {"number": 9, "url": "u", "branch": "flowee/5"}})]
            self.assertEqual(call("branch", "5")[:2], (0, "flowee/5"))
            self.assertEqual(self.g("rev-parse", "--abbrev-ref", "HEAD", cwd=self.d / "a").strip(), "flowee/5")
            rc, _, err = call("pr", "5")
            self.assertEqual(rc, 2)
            self.assertIn("refused: no commit on flowee/5 beyond main: commit first", err)
            (self.d / "a/f").write_text("5\n")
            self.green()
            with contextlib.redirect_stdout(io.StringIO()):
                flowee.cmd_commit(5, "fix(x): five", ["f"])
            rc, out, _ = call("pr", "5")
            self.assertEqual((rc, json.loads(out)), (0, {"pull": {"number": 9, "url": "u", "branch": "flowee/5"}}))
            self.assertEqual(s.got[-1]["body"], {"n": 5})
            heads = self.g("ls-remote", "--heads", "origin", cwd=self.d / "a")
            self.assertIn("refs/heads/flowee/5", heads)
            main = self.g("rev-parse", "origin/main", cwd=self.d / "a").strip()
            self.assertEqual(self.g("ls-remote", "origin", "refs/heads/main", cwd=self.d / "a").split()[0], main)  # main untouched
            (self.d / "a/f").write_text("6\n")
            self.green()
            with contextlib.redirect_stdout(io.StringIO()):
                flowee.cmd_commit(5, "fix(x): six", ["f"])
                self.assertEqual(flowee.cmd_push(), 0)
            self.assertIn(self.g("rev-parse", "HEAD", cwd=self.d / "a").strip(), self.g("ls-remote", "origin", "refs/heads/flowee/5", cwd=self.d / "a"))
            self.g("switch", "-q", "main", cwd=self.d / "a")
            self.assertEqual(call("branch", "5")[:2], (0, "flowee/5"))  # the existing local branch again
        finally:
            s.srv.shutdown()

    def test_push_refuses_a_commit_without_ticket(self):
        os.chdir(self.d / "b")
        (self.d / "b/h").write_text("b\n")
        self.g("add", "h")
        self.g("commit", "-q", "-S", "-m", "feat(x): no ticket")
        with self.assertRaises(flowee.Refused):
            flowee.cmd_push()

    def test_gates_come_from_the_config_and_keep_their_own_logs(self):
        os.chdir(self.d / "a")
        os.environ["FLOWEE_GATES_LOGS"] = str(self.d / "logs")
        dirs = []
        for _ in range(2):
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(flowee.cmd_gates(), 0)
            g = json.loads(flowee.gates_file().read_text())
            dirs.append(g["logs"])
            self.assertEqual((g["ok"], g["clean"], g["sha"]), (True, True, self.g("rev-parse", "HEAD").strip()))
        self.assertNotEqual(dirs[0], dirs[1])
        for d in dirs:
            self.assertEqual(os.listdir(d), ["one.log"])

    def test_busy_only_for_young_changes(self):
        os.chdir(self.d / "a")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(flowee.cmd_busy(), 0)
            (self.d / "a/f").write_text("dirty\n")
            self.assertEqual(flowee.cmd_busy(), 2)
            self.assertEqual(flowee.cmd_busy(now=os.path.getmtime(self.d / "a/f") + 3 * 3600), 0)


if __name__ == "__main__":
    unittest.main(verbosity=1)
