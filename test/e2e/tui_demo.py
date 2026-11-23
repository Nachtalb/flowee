#!/usr/bin/env python3
"""flowee-tui, the real client, in a pseudo-terminal against a local instance (the bun runtime, or the Worker in
`wrangler dev` with --runtime worker) and a stand-in GitHub: a demo walk through the inbox, a card, an answer, the
help, the list, a file answer, the notices, a new ticket and a second person, with screenshots as text and PNG.

    python3 test/e2e/tui_demo.py [--runtime bun|worker] [--out DIR] [--size 100x30]

Exit 0 when every step showed what it should and the tracker got the answers. The PNGs need Pillow.
"""
import argparse, codecs, hashlib, json, os, pty, re, select, signal, struct, subprocess, sys, tempfile, termios, fcntl, time, unicodedata, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent))
from wire import GitHub, SelfHosted, free_port  # noqa: E402
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402
import threading  # noqa: E402


class Hub(GitHub):
    """The wire stand-in, plus the repository itself (the wizard's token check reads it) and an empty repository list."""

    def handle(self, method, path, body):
        url = path.partition("?")[0]
        if method == "GET" and re.match(r"^/repos/[^/]+/[^/]+$", url):
            return 200, {"full_name": url[7:], "permissions": {"push": True}}
        if method == "GET" and url in ("/user/repos", "/installation/repositories"):
            return 200, []
        return super().handle(method, path, body)


class Paste:
    """A rustypaste stand-in: keeps the uploads, answers each one's link."""

    def __init__(self):
        self.files = []
        me = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                name = re.search(rb'filename="([^"]+)"', raw)
                me.files.append(name.group(1).decode() if name else "file")
                body = f"https://paste.test/{me.files[-1]}\n".encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_port}"

CARD_Q = "### For Ann\nKind: question\nQuestion: Should the export be **CSV** or JSON? I recommend CSV: every spreadsheet opens it.\n\nChanged:\n- the export button\n- `export.ts`"
CARD_T = "### For Ann\nKind: test\nChanged: Lessons load faster on slow phones\nCheck:\n- open a lesson on a slow connection\n- it shows within two seconds\nVersion: v1.4.0"
CARD_D = "### For Ann\nKind: decision\nQuestion: Ship the dark theme now or after the redesign?"


# ---- a small VT emulator: what the client writes, as a grid of cells ----

def cp_width(ch):
    o = ord(ch)
    if o < 32 or 0x7f <= o < 0xa0:
        return 0
    if unicodedata.combining(ch) or 0x200b <= o <= 0x200f or 0xfe00 <= o <= 0xfe0f or o == 0x200d:
        return 0
    if unicodedata.east_asian_width(ch) in "WF":
        return 2
    return 1


class Term:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.grid = [[(" ", 0, 0) for _ in range(w)] for _ in range(h)]  # char, style bits, colour
        self.x = self.y = 0
        self.style = (0, 0)
        self.buf = ""

    def feed(self, data):
        s = self.buf + data
        self.buf = ""
        i = 0
        while i < len(s):
            c = s[i]
            if c == "\x1b":
                m = re.match(r"\x1b\[([?<]?)([\d;]*)([A-Za-z])", s[i:])
                if m:
                    self.csi(m.group(1), m.group(2), m.group(3))
                    i += m.end()
                    continue
                m = re.match(r"\x1b\][^\x07]*(\x07|\x1b\\)", s[i:])
                if m:
                    i += m.end()
                    continue
                if len(s) - i < 32:
                    self.buf = s[i:]
                    return
                i += 1
                continue
            if c in "\r\n":
                i += 1
                continue
            # a grapheme: the char and its combining marks / VS16 / ZWJ sequence
            j = i + 1
            while j < len(s) and (cp_width(s[j]) == 0 and s[j] not in "\x1b\r\n" or (s[j - 1] == "\u200d")):
                j += 1
            g = s[i:j]
            wdt = cp_width(g[0])
            if wdt == 1 and "\ufe0f" in g:
                wdt = 2
            if wdt and 0 <= self.y < self.h and self.x < self.w:
                self.grid[self.y][self.x] = (g, *self.style)
                if wdt == 2 and self.x + 1 < self.w:
                    self.grid[self.y][self.x + 1] = ("", *self.style)
                self.x += wdt
            i = j

    def csi(self, priv, params, cmd):
        nums = [int(p) if p else 0 for p in params.split(";")] if params else []
        if priv:
            return
        if cmd == "H":
            self.y = (nums[0] if nums else 1) - 1
            self.x = (nums[1] if len(nums) > 1 else 1) - 1
        elif cmd == "J":
            self.grid = [[(" ", 0, 0) for _ in range(self.w)] for _ in range(self.h)]
        elif cmd == "m":
            bits, col = 0, 0
            for n in nums or [0]:
                if n == 0:
                    bits, col = 0, 0
                elif n in (1, 2, 3, 4, 7):
                    bits |= {1: 1, 2: 2, 3: 4, 4: 8, 7: 16}[n]
                elif 30 <= n <= 37:
                    col = n - 30
            self.style = (bits, col)

    def text(self):
        return "\n".join("".join(c[0] for c in row).rstrip() for row in self.grid)


# ---- PNG ----

PALETTE = {0: (220, 223, 228), 1: (240, 113, 120), 2: (152, 195, 121), 3: (229, 192, 123), 4: (97, 175, 239), 5: (198, 120, 221), 6: (86, 182, 194), 7: (220, 223, 228)}
BG = (30, 33, 39)


def png(term, path):
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return False
    fonts = {}
    def font(bold, italic):
        k = (bold, italic)
        if k not in fonts:
            name = {(0, 0): "regular", (1, 0): "bold", (0, 1): "italic", (1, 1): "bolditalic"}[k]
            for p in [f"/usr/local/share/fonts/pandoc-fonts/drake-fonts/jetbrainsmono-{name}.ttf", "/usr/share/fonts/liberation/LiberationMono-Regular.ttf"]:
                if os.path.exists(p):
                    fonts[k] = ImageFont.truetype(p, 17)
                    break
        return fonts[k]
    emoji = None
    for p in [os.path.expanduser("~/.fonts/oneui.ttc"), "/usr/share/fonts/noto/NotoColorEmoji.ttf", "/usr/share/fonts/google-noto-emoji/NotoColorEmoji.ttf"]:
        if os.path.exists(p):
            for size in (96, 64, 40, 160, 137, 109):
                try:
                    emoji = (ImageFont.truetype(p, size), size)
                    break
                except OSError:
                    continue
            if emoji:
                break
    cw, ch = 11, 23
    img = Image.new("RGB", (term.w * cw + 24, term.h * ch + 24), BG)
    d = ImageDraw.Draw(img)
    for y, row in enumerate(term.grid):
        for x, (g, bits, col) in enumerate(row):
            if g == "":
                continue
            wide = x + 1 < term.w and row[x + 1][0] == ""
            fgc, bgc = PALETTE.get(col, PALETTE[0]), BG
            if bits & 2:
                fgc = tuple(int(c * 0.6 + b * 0.4) for c, b in zip(fgc, BG))
            if bits & 16:
                fgc, bgc = (BG if col == 0 else BG), (PALETTE.get(col, PALETTE[0]) if col else (200, 204, 212))
            px, py = 12 + x * cw, 12 + y * ch
            if bgc != BG:
                d.rectangle([px, py, px + cw * (2 if wide else 1) - 1, py + ch - 1], fill=bgc)
            if g == " ":
                continue
            if wide and emoji and ord(g[0]) > 0x2000:
                try:
                    f, size = emoji
                    tile = Image.new("RGBA", (size + 40, size + 40), (0, 0, 0, 0))
                    ImageDraw.Draw(tile).text((0, 0), g, font=f, embedded_color=True)
                    box = tile.getbbox()
                    if box:
                        tile = tile.crop(box)
                        s = min(cw * 2 - 2, ch - 3)
                        tile = tile.resize((s, s))
                        img.paste(tile, (px + 1, py + 2), tile)
                        continue
                except Exception:
                    pass
            heavy = g in "━┃┏┓┗┛"
            g = {"━": "─", "┃": "│", "┏": "┌", "┓": "┐", "┗": "└", "┛": "┘"}.get(g, g)
            if g in "─│┌┐└┘▐":
                mid_x, mid_y = px + cw // 2, py + ch // 2
                line = dict(fill=fgc, width=3 if heavy else 1)
                if g == "─": d.line([px, mid_y, px + cw, mid_y], **line)
                elif g == "│": d.line([mid_x, py, mid_x, py + ch], **line)
                elif g == "▐": d.rectangle([px + cw // 2, py, px + cw - 1, py + ch - 1], fill=fgc)
                elif g == "┌": d.line([mid_x, mid_y, px + cw, mid_y], **line); d.line([mid_x, mid_y, mid_x, py + ch], **line)
                elif g == "┐": d.line([px, mid_y, mid_x, mid_y], **line); d.line([mid_x, mid_y, mid_x, py + ch], **line)
                elif g == "└": d.line([mid_x, py, mid_x, mid_y], **line); d.line([mid_x, mid_y, px + cw, mid_y], **line)
                elif g == "┘": d.line([mid_x, py, mid_x, mid_y], **line); d.line([px, mid_y, mid_x, mid_y], **line)
                continue
            f = font(bits & 1, bits & 4 and 1)
            # a symbol the text font lacks (✖, ⏭ without VS16) comes from the emoji font, one cell wide
            if ord(g[0]) > 0x2000 and emoji and not f.getmask(g).getbbox():
                try:
                    ef, size = emoji
                    tile = Image.new("RGBA", (size + 40, size + 40), (0, 0, 0, 0))
                    ImageDraw.Draw(tile).text((0, 0), g, font=ef, embedded_color=True)
                    box = tile.getbbox()
                    if box:
                        tile = tile.crop(box)
                        s = min(cw, ch - 4)
                        tile = tile.resize((s, s))
                        img.paste(tile, (px, py + 5), tile)
                        continue
                except Exception:
                    pass
            d.text((px, py + 2), g, font=f, fill=fgc)
            if bits & 8:
                d.line([px, py + ch - 3, px + cw * (2 if wide else 1), py + ch - 3], fill=fgc)
    img.save(path)
    return True


# ---- the client in a pty ----

class Client:
    def __init__(self, url, key_file, cfg, w, h, out):
        self.term = Term(w, h)
        self.out = out
        self.dec = codecs.getincrementaldecoder("utf8")("replace")
        pid, fd = pty.fork()
        if pid == 0:
            env = dict(os.environ, XDG_CONFIG_HOME=str(cfg), TERM="xterm-256color", COLORTERM="", NO_COLOR="")
            env.pop("NO_COLOR")
            os.chdir(str(cfg))
            os.execvpe("bun", ["bun", str(ROOT / "tui/main.ts"), "--url", url, "--key-file", str(key_file)], env)
        self.pid, self.fd = pid, fd
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", h, w, 0, 0))
        os.kill(pid, signal.SIGWINCH)

    def pump(self, secs):
        end = time.time() + secs
        while True:
            left = end - time.time()
            if left <= 0:
                return
            r, _, _ = select.select([self.fd], [], [], left)
            if not r:
                return
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                return
            self.term.feed(self.dec.decode(data))

    def until(self, pattern, secs=15):
        end = time.time() + secs
        while time.time() < end:
            self.pump(0.15)
            if re.search(pattern, self.term.text()):
                self.pump(0.3)
                return True
        raise SystemExit(f"the screen never showed {pattern!r}:\n{self.term.text()}")

    def keys(self, s, settle=0.6):
        os.write(self.fd, s.encode())
        self.pump(settle)

    def click(self, label, last=True):
        """Clicks the label where the screen shows it (the newest/lowest one): an SGR mouse press and release."""
        hits = []
        for y, row in enumerate(self.term.grid):
            s, cells = "", []
            for x, (g, *_rest) in enumerate(row):
                if g == "":
                    continue
                cells.extend([x] * len(g))
                s += g
            i = s.find(label)
            if i >= 0:
                hits.append((y, cells[i]))
        if not hits:
            raise SystemExit(f"no {label!r} on screen:\n{self.term.text()}")
        y, x = hits[-1] if last else hits[0]
        os.write(self.fd, f"\x1b[<0;{x + 2};{y + 1}M\x1b[<0;{x + 2};{y + 1}m".encode())
        self.pump(0.8)

    def shot(self, name):
        (self.out / f"{name}.txt").write_text(self.term.text() + "\n")
        png(self.term, self.out / f"{name}.png")
        print(f"  {name}")

    def resize(self, w, h):
        self.term = Term(w, h)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", h, w, 0, 0))
        os.kill(self.pid, signal.SIGWINCH)
        self.pump(0.8)

    def close(self):
        try:
            os.write(self.fd, b"\x1bq")
            self.pump(0.5)
            if os.waitpid(self.pid, os.WNOHANG) == (0, 0):
                os.kill(self.pid, signal.SIGTERM)
                os.waitpid(self.pid, 0)
        except OSError:
            pass


def api(url, token, path, body=None):
    req = urllib.request.Request(f"{url}{path}", data=json.dumps(body).encode() if body is not None else None, method="POST" if body is not None else "GET",
                                 headers={"authorization": f"Bearer {token}", "content-type": "application/json", "User-Agent": "tui-demo"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runtime", choices=["bun", "worker"], default="bun")
    ap.add_argument("--out", default=os.path.expanduser("~/.hermes/cache/scratch/flowee/t/shots"))
    ap.add_argument("--size", default="110x32")
    a = ap.parse_args()
    w, h = map(int, a.size.split("x"))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix="flowee-tui-demo-"))
    gh = Hub()
    paste = Paste()
    ann_key, bob_key = "fwk_demo-ann-0000000000000000000000000000000", "fwk_demo-bob-0000000000000000000000000000000"
    dig = lambda k: hashlib.sha256(k.encode()).hexdigest()
    who = {"board": "board", "dev1": "developer", "tester": "tester", "owner": "owner"}
    def ws(id, name, people):
        return {"flowee": 1, "id": id, "name": name, "flow": {"preset": "trunk"},
                "tracker": {"type": "github", "repos": [f"acme/{id}"], "api": gh.url, "token": "GITHUB_TOKEN"},
                "roles": [{"instance": i, "role": r, "secret": f"{id.upper()}_{i.upper()}"} for i, r in who.items()],
                "owners": [{"name": "Ann", "tracker": "ann"}], "texts": {"owner": "Ann", "cardHeading": "For Ann"},
                "tui": {"people": people}, "files": {"url": paste.url, "token": "PASTE_TOKEN"}, "sync": {"webhooks": "off"}}
    config = {"flowee": 1, "workspaces": [
        ws("shop", "Shop", [{"id": "ann", "name": "Ann", "role": "manager", "key": dig(ann_key)}]),
        ws("crew", "Crew", [{"id": "ann", "name": "Ann", "role": "manager", "key": dig(ann_key)}, {"id": "bob", "name": "Bob", "key": dig(bob_key)}]),
    ]}
    secrets = {"GITHUB_TOKEN": "gh-test", "FLOWEE_KEY": "demo-key", "PASTE_TOKEN": "paste-test"}
    for wid in ("shop", "crew"):
        for i in who:
            secrets[f"{wid.upper()}_{i.upper()}"] = dig(f"{wid}-{i}")
    proc = rt = None
    if a.runtime == "bun":
        class NoTelegram:
            url = "http://127.0.0.1:9"
        rt = SelfHosted("bun", scratch, config, NoTelegram(), None)
        os.environ.update(secrets)
        rt.start()
        url = rt.url
        # SelfHosted passes its own secrets; ours are in the config's names
    else:
        port = free_port()
        args = ["npx", "wrangler", "dev", "--ip", "127.0.0.1", "--port", str(port), "--persist-to", str(scratch / "state"), "--show-interactive-dev-session=false",
                "--var", f"FLOWEE_CONFIG:{json.dumps(config)}"] + [x for k, v in secrets.items() for x in ("--var", f"{k}:{v}")]
        proc = subprocess.Popen(args, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=dict(os.environ, NO_COLOR="1"))
        for line in proc.stdout:
            if "Ready on" in line:
                break
        url = f"http://127.0.0.1:{port}"
    ok = False
    c = None
    try:
        for wid in ("shop", "crew"):
            gh.repo(f"acme/{wid}")
        for n, card, title in [(1, CARD_Q, "Export format for the reports"), (2, CARD_T, "Faster lessons on slow phones"), (3, CARD_D, "Dark theme timing")]:
            seed(gh, "acme/shop", n, title)
            api(url, "shop-board", "/v1/escalate", {"n": n, "comment": card})
        seed(gh, "acme/crew", 1, "Pick the release name")
        api(url, "crew-board", "/v1/escalate", {"n": 1, "comment": CARD_D})
        key_file = scratch / "ann.key"
        key_file.write_text(ann_key + "\n")
        os.chmod(key_file, 0o600)
        cfg = scratch / "cfg"
        cfg.mkdir()
        (cfg / "answer.png").write_bytes(b"\x89PNG demo")
        print(f"screens in {out}:")
        c = Client(url, key_file, cfg, w, h, out)
        c.until(r"live")
        c.until(r"Question:")
        c.shot("01-inbox-and-card")
        c.keys("a")
        c.keys("CSV, please. Keep the column order of the screen.", 0.3)
        c.shot("03-editor")
        c.keys("\x13")
        c.until(r"Ann: CSV")
        c.shot("04-sent")
        c.keys("n")
        c.until(r"Check:")
        c.shot("05-next-card")
        c.keys("a")
        c.keys("\x0f")
        c.until(r"Attach a file")
        c.keys("answer.png")
        c.shot("06-file-picker")
        c.keys("\r")
        c.until(r"answer.png sent|📎 answer.png")
        c.keys("\x1b")
        c.keys("n")
        c.keys("l")
        c.until(r"answered today")
        c.shot("07-list")
        c.keys("b")
        c.keys("?")
        c.until(r"Keys · Esc closes")
        c.shot("08-help")
        c.keys("\x1b")
        c.keys("!")
        c.shot("09-notices")
        c.keys("\x1b")
        c.keys("w")
        c.until(r"Workspaces")
        c.shot("10-workspaces")
        c.keys("j\r")
        c.until(r"Pick the release name")
        c.shot("11-team-workspace")
        c.resize(80, 24)
        c.shot("12-small-80x24")
        c.close()
        c = None
        comments = [cm["body"] for i in gh.repo("acme/shop")["issues"].values() for cm in i.get("comments", [])]
        answered = [x for x in comments if x.startswith("Ann: ")]
        print("  tracker:", json.dumps(answered))
        ok = any("CSV, please" in x for x in answered) and any("answer.png" in x for x in answered)
        if rt:
            ok = managed_walk(scratch, gh, out, w, h) and ok
        # the sign-in screen: a person with no key yet
        c = Client(url, scratch / "nobody.key", cfg, w, h, out)
        c.until(r"Sign in to Flowee")
        c.shot("00-sign-in")
        c.keys("\x0e")
        c.until(r"Waiting for your key")
        c.shot("00-pairing")
        c.keys("q")
    finally:
        if c:
            c.close()
        if rt:
            rt.stop()
        if proc:
            proc.terminate()
            proc.wait(timeout=20)
    print("ok" if ok else "FAILED: the tracker did not get the answers")
    sys.exit(0 if ok else 1)


def managed_walk(scratch, gh, out, w, h):
    """The managed mode's setup seat: the wizard and the menu in the terminal, the agents' secrets saved as a file."""
    key = "fwk_demo-mia-00000000000000000000000000000000"
    cfg = {"flowee": 1, "workspaces": [], "instance": {"bot": {"token": "BOT", "webhookSecret": "HOOK"}, "publicUrl": "https://flowee.example", "owner": "1",
           "trackerApi": gh.url, "tui": {"people": [{"id": "mia", "name": "Mia", "role": "manager", "key": hashlib.sha256(key.encode()).hexdigest()}]}}}
    gh.repo("acme/app")

    class NoTelegram:
        url = "http://127.0.0.1:9"
    rt = SelfHosted("bun", scratch / "managed", cfg, NoTelegram(), None)
    (scratch / "managed").mkdir()
    os.environ.update({"FLOWEE_MODE": "managed", "FLOWEE_ADMIN_TOKEN": "admin-demo"})
    rt.start()
    os.environ.pop("FLOWEE_MODE")
    kf = scratch / "mia.key"
    kf.write_text(key + "\n")
    cfgdir = scratch / "cfg-mia"
    cfgdir.mkdir()
    c = Client(rt.url, kf, cfgdir, w, h, out)
    try:
        c.until(r"Welcome to Flowee")
        c.shot("20-setup-welcome")
        c.click("Set up a workspace")
        c.until(r"Step 1 of")
        c.shot("21-wizard-repos")
        c.keys("a")
        c.keys("https://github.com/acme/app", 0.3)
        c.keys("\x13")
        c.until(r"Single branch")
        c.shot("22-wizard-flow")
        c.click("🔀 Choose")
        c.until(r"Versioning")
        c.shot("23-wizard-options")
        c.click("Next")
        c.until(r"token")
        c.shot("24-wizard-token")
        c.keys("a")
        c.keys("github_pat_" + "a" * 40, 0.3)
        c.keys("\x13")
        c.until(r"Agents|agents|Last check")
        if "Last check" not in c.term.text():
            c.shot("25-wizard-agents")
            c.click("Next")
        c.until(r"Last check")
        c.shot("26-wizard-summary")
        c.click("Create")
        c.until(r"Saved to .*flowee-app-sec", 20)
        c.shot("27-secrets-saved")
        c.keys(":")
        c.keys("workspaces\r")
        c.until(r"Your workspaces")
        c.click("Open")
        c.until(r"Terminal people")
        c.shot("28-menu-workspace")
        c.click("👥 People")
        c.until(r"Who can use")
        c.click("➕ Member")
        c.until(r"Saved to .*\.key")
        c.shot("29-menu-people")
        return True
    except SystemExit as e:
        print(f"  managed walk: {e}")
        return False
    finally:
        c.close()
        rt.stop()


def seed(gh, repo, n, title):
    r = gh.repo(repo)
    r["issues"][n] = {"number": n, "title": title, "body": "## Acceptance\n- works", "state": "open", "state_reason": None, "labels": [{"name": "board review"}], "assignees": [],
                      "created_at": "2026-11-01T00:00:00Z", "updated_at": "2026-11-02T00:00:00Z", "html_url": f"https://github.test/{repo}/issues/{n}", "node_id": f"I_{n}", "comments": []}


if __name__ == "__main__":
    main()
