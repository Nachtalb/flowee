// flowee-tui: the terminal interface to a Flowee instance (docs/tui.md). This file is the machine side: arguments,
// the config directory and the key file, the terminal (alternate screen, raw keys, mouse, paste, resize), the
// network (sync, the WebSocket doorbell, reconnecting). Everything the person sees is app.ts.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { TuiFrame, TuiSeat, TuiSync } from "../src/ports/tui";
import { App, Editor, type Sys } from "./app";
import { parseInput } from "./input";
import { Screen } from "./screen";

export const VERSION = "0.1.0";

interface Proc {
  argv: string[];
  env: Record<string, string | undefined>;
  platform: string;
  cwd(): string;
  exit(code?: number): never;
  on(ev: string, fn: (...a: unknown[]) => void): void;
  stdin: { isTTY?: boolean; setRawMode(on: boolean): void; on(ev: "data", fn: (d: Uint8Array | string) => void): void; resume(): void; setEncoding(e: string): void };
  stdout: { isTTY?: boolean; columns: number; rows: number; write(s: string): boolean; on(ev: "resize", fn: () => void): void };
  stderr: { write(s: string): boolean };
}
const proc = process as unknown as Proc;

const USAGE = `flowee-tui: the terminal interface to a Flowee inbox (docs/tui.md)

  flowee-tui --url <instance> [--key-file <path>] [--workspace <id>] [--no-color]
  flowee-tui --new-key [--key-file <path>] [--force]   make a key; prints only its digest for your admin
  flowee-tui --version

The URL and the last workspace are remembered in the config directory ($XDG_CONFIG_HOME/flowee-tui or
~/.config/flowee-tui); the key is kept in <config>/key with mode 600 and never printed.
`;

function args(argv: string[]) {
  const o: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [k, v] = a.slice(2).split("=", 2);
    if (v !== undefined) o[k] = v;
    else if (["url", "key-file", "workspace"].includes(k)) o[k] = argv[++i] ?? "";
    else o[k] = true;
  }
  return o;
}

const configDir = () => join(proc.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "flowee-tui");

function writePrivate(path: string, data: string) {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, data, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function newKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return `fwk_${btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

export async function digest(key: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key.trim()));
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** The machine: files with mode 600, the file picker's folders, links, the clipboard over OSC 52. */
function sys(write: (s: string) => void): Sys {
  const files = join(configDir(), "files");
  return {
    cwd: proc.cwd(),
    home: homedir(),
    now: () => Date.now(),
    save(name, data) {
      const safe = basename(name).replace(/[^A-Za-z0-9._-]/g, "_") || "file";
      let path = join(files, safe);
      for (let i = 2; existsSync(path); i++) path = join(files, safe.replace(/(\.[^.]*)?$/, `-${i}$1`));
      writePrivate(path, data);
      return path;
    },
    read(path) {
      let st: { size: number; isFile(): boolean };
      try {
        st = statSync(path) as typeof st;
      } catch {
        throw new Error(`There is no file ${path}.`);
      }
      if (!st.isFile()) throw new Error(`${path} is not a file.`);
      if (st.size > 20 * 1024 * 1024) return { name: basename(path), data: "", size: st.size };
      return { name: basename(path), data: b64(readFileSync(path)), size: st.size };
    },
    list(dir) {
      return readdirSync(dir)
        .filter((n) => !n.startsWith("."))
        .map((name) => {
          let isDir = false;
          try {
            isDir = (statSync(join(dir, name)) as unknown as { isDirectory(): boolean }).isDirectory();
          } catch {}
          return { name, dir: isDir };
        });
    },
    open(url) {
      const desktop = proc.platform === "darwin" || proc.platform === "win32" || !!(proc.env.DISPLAY || proc.env.WAYLAND_DISPLAY);
      if (desktop && !proc.env.SSH_CONNECTION) {
        try {
          const cmd = proc.platform === "darwin" ? "open" : proc.platform === "win32" ? "explorer" : "xdg-open";
          spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
          return `Opened ${url}`;
        } catch {}
      }
      this.copy(url);
      return `Copied the link (no browser here): ${url}`;
    },
    copy(text) {
      write(`\x1b]52;c;${btoa(String.fromCharCode(...new TextEncoder().encode(text)))}\x07`);
    },
  };
}

type Net = { url: string; key: string };

async function api(n: Net, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${n.url}/tui/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${n.key}`, "content-type": "application/json", "user-agent": `flowee-tui/${VERSION}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, message: `The instance answered ${res.status} without JSON.` };
  }
  return { status: res.status, body: json };
}

async function main() {
  const o = args(proc.argv.slice(2));
  if (o.help) return void proc.stdout.write(USAGE);
  if (o.version) return void proc.stdout.write(`flowee-tui ${VERSION}\n`);
  const dir = configDir();
  const keyFile = typeof o["key-file"] === "string" ? resolve(o["key-file"]) : join(dir, "key");
  const cfgFile = join(dir, "config.json");
  const cfg = (existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, "utf8")) : {}) as { url?: string; workspace?: string };
  const saveCfg = () => writePrivate(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`);
  if (o["new-key"]) {
    if (existsSync(keyFile) && !o.force) {
      proc.stderr.write(`${keyFile} exists; --force replaces it (the old key stops working once removed from the workspaces).\n`);
      return proc.exit(1);
    }
    const key = newKey();
    writePrivate(keyFile, `${key}\n`);
    proc.stdout.write(`Key saved to ${keyFile} (mode 600). Its digest, for your admin:\n${await digest(key)}\n`);
    return;
  }
  const url = (typeof o.url === "string" ? o.url : cfg.url ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/.test(url)) {
    proc.stderr.write(`${USAGE}\nGive the instance's address: --url https://flowee.example\n`);
    return proc.exit(2);
  }
  if (!proc.stdin.isTTY || !proc.stdout.isTTY) {
    proc.stderr.write("flowee-tui needs a terminal (stdin and stdout a TTY).\n");
    return proc.exit(2);
  }
  cfg.url = url;
  saveCfg();

  // ---- the terminal ----
  let out = "";
  const write = (s: string) => void (out += s);
  const flush = () => {
    if (out) proc.stdout.write(out);
    out = "";
  };
  const app = new App(sys(write));
  app.color = !o["no-color"] && !proc.env.NO_COLOR && proc.env.TERM !== "dumb";
  let prev: Screen | undefined;
  const restore = () => proc.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l");
  proc.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[2J");
  proc.stdin.setRawMode(true);
  proc.stdin.setEncoding("utf8");
  let drawing: ReturnType<typeof setTimeout> | undefined;
  const draw = () => {
    drawing = undefined;
    const sc = new Screen(Math.max(20, proc.stdout.columns || 80), Math.max(8, proc.stdout.rows || 24));
    app.w = sc.w;
    app.h = sc.h;
    app.draw(sc);
    write(sc.ansi(prev, app.color));
    prev = sc;
    flush();
    if (app.quit) stop(0);
  };
  const redraw = () => void (drawing ??= setTimeout(draw, 12));
  const stop = (code: number) => {
    restore();
    proc.exit(code);
  };
  proc.on("SIGTERM", () => stop(0));
  proc.on("SIGHUP", () => stop(0));
  proc.on("uncaughtException", (e) => {
    restore();
    proc.stderr.write(`flowee-tui: ${e instanceof Error ? e.stack : e}\n`);
    proc.exit(1);
  });
  proc.stdout.on("resize", () => {
    prev = undefined;
    write("\x1b[2J");
    redraw();
  });
  let pending = "";
  proc.stdin.on("data", (d) => {
    const { events, rest } = parseInput(pending + String(d));
    pending = rest;
    for (const e of events) app.input(e);
    redraw();
  });
  proc.stdin.resume();
  setInterval(redraw, 1000);

  // ---- the network ----
  const net: Net = { url, key: existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : "" };
  const running = new Set<string>();
  const again = new Set<string>();
  let failures = 0;
  const sync = async (ws: string): Promise<void> => {
    if (running.has(ws)) return void again.add(ws);
    running.add(ws);
    const frames = app.take(ws);
    try {
      const after = app.convs.get(ws)?.seq ?? 0;
      const r = await api(net, `w/${ws}/sync`, { after, send: frames });
      if (r.status !== 200) {
        app.requeue(ws, r.status >= 500 ? frames : []);
        app.say(r.body?.message ?? `The instance answered ${r.status}.`, true);
        if (r.status === 401) void signIn("Your key no longer opens this workspace.");
      } else {
        app.synced(ws, r.body as TuiSync);
        failures = 0;
        if (app.conn === "offline" || app.conn === "connecting") app.conn = socket ? "online" : "polling";
        if ((r.body as TuiSync).seq > (app.convs.get(ws)?.seq ?? 0)) again.add(ws);
      }
    } catch {
      app.requeue(ws, frames);
      app.conn = "offline";
      failures++;
      setTimeout(() => void sync(ws), Math.min(30, 2 ** failures) * 1000);
    } finally {
      running.delete(ws);
      redraw();
      if (again.delete(ws) || (app.outbox.get(ws)?.length ?? 0) > 0) void sync(ws);
    }
  };
  app.kick = (ws) => void sync(ws);

  let socket: WebSocket | undefined;
  let socketFor = "";
  const ring = (ws: string) => {
    socket?.close();
    socket = undefined;
    socketFor = ws;
    const wsUrl = `${url.replace(/^http/, "ws")}/tui/v1/w/${ws}/socket`;
    let s: WebSocket;
    try {
      s = new (WebSocket as unknown as new (u: string, o: unknown) => WebSocket)(wsUrl, { headers: { authorization: `Bearer ${net.key}`, "user-agent": `flowee-tui/${VERSION}` } });
    } catch {
      app.conn = "polling";
      return;
    }
    s.addEventListener("open", () => {
      socket = s;
      app.conn = "online";
      void sync(ws);
      redraw();
    });
    s.addEventListener("message", (e) => {
      if (String(e.data) !== "pong") void sync(ws);
    });
    s.addEventListener("close", () => {
      if (socket === s) socket = undefined;
      if (socketFor !== ws) return;
      if (app.conn === "online") app.conn = "polling";
      redraw();
      setTimeout(() => socketFor === ws && !socket && ring(ws), 5000);
    });
    s.addEventListener("error", () => {});
  };
  setInterval(() => {
    socket?.send("ping");
    if (app.ws && (!socket || Date.now() % 30000 < 5000)) void sync(app.ws);
  }, 5000);

  const start = (seats: TuiSeat[]) => {
    app.signin = undefined;
    app.seats = seats;
    const pick = seats.find((s) => s.id === (typeof o.workspace === "string" ? o.workspace : cfg.workspace)) ?? seats[0];
    app.ws = pick.id;
    cfg.workspace = pick.id;
    saveCfg();
    void sync(pick.id);
    ring(pick.id);
  };
  app.onSwitch = (ws) => {
    cfg.workspace = ws;
    saveCfg();
    void sync(ws);
    ring(ws);
  };
  let waiting: ReturnType<typeof setInterval> | undefined;
  const signIn = async (note = ""): Promise<void> => {
    if (!net.key) {
      app.signin = { editor: new Editor(), note, mode: "paste" };
      return redraw();
    }
    let r: { status: number; body: any };
    try {
      r = await api(net, "me");
    } catch {
      app.conn = "offline";
      app.signin ??= { editor: new Editor(), note: "", mode: "wait", digest: await digest(net.key) };
      app.signin.note = `${url} does not answer; trying again.`;
      redraw();
      setTimeout(() => void signIn(), 5000);
      return;
    }
    app.conn = "connecting";
    if (r.status === 200 && r.body.workspaces?.length) {
      if (waiting) clearInterval(waiting);
      waiting = undefined;
      start(r.body.workspaces as TuiSeat[]);
    } else {
      app.signin = { editor: new Editor(), note: r.status === 401 ? note || "This key opens no workspace yet." : (r.body?.message ?? `The instance answered ${r.status}.`), mode: "wait", digest: await digest(net.key) };
      // pairing: once an admin adds the digest, the next check signs in
      waiting ??= setInterval(() => void signIn(), 10000);
    }
    redraw();
  };
  app.onKey = (key) => {
    net.key = key;
    writePrivate(keyFile, `${key}\n`);
    void signIn();
  };
  app.onNewKey = () => {
    net.key = newKey();
    writePrivate(keyFile, `${net.key}\n`);
    void signIn("A new key was made and saved.");
  };
  await signIn();
  redraw();
}

void main();
