// `flowee` (bun run start, or the compiled binary): serves until SIGTERM/SIGINT. `flowee health` asks a running
// one on FLOWEE_PORT (the container's HEALTHCHECK, no shell needed); `flowee version`; `flowee validate <file>…` checks
// documents before a first start, with the Worker's validator (exit 0/1/2, as `bun run validate`).
import pkg from "../../../package.json";
import { App, jsonLog } from "./app";
import { load } from "./config";
import { validate } from "./validate";

const cmd = process.argv[2] ?? "serve";

if (cmd === "version" || cmd === "--version") {
  process.stdout.write(`flowee ${pkg.version} (bun ${Bun.version})\n`);
  process.exit(0);
}

if (cmd === "health") {
  const port = process.env.FLOWEE_PORT ?? process.env.PORT ?? "8787";
  const ok = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) }).then(
    (r) => r.ok,
    () => false,
  );
  process.exit(ok ? 0 : 1);
}

if (cmd === "validate") {
  const out = (s: string) => process.stdout.write(`${s}\n`);
  process.exit(validate(process.argv.slice(3), out, (s) => process.stderr.write(`${s}\n`)));
}

if (cmd !== "serve") {
  process.stderr.write("usage: flowee [serve | health | version | validate <file>…]   (configuration: docs/self-hosting.md)\n");
  process.exit(2);
}

const cfg = await load(process.env);
const log = jsonLog(cfg.options.debug);
if (cfg.problems.length) {
  for (const p of cfg.problems) log("error", p);
  process.exit(2);
}
for (const n of cfg.notes) log("warn", n);
let app: App;
try {
  app = new App(cfg.env, cfg.options, log);
} catch (e) {
  log("error", e instanceof Error ? e.message : String(e));
  process.exit(1);
}
await app.start();
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  app.stop().then(
    () => process.exit(0),
    (e) => {
      log("error", "stop failed", { error: e instanceof Error ? e.message : String(e) });
      process.exit(1);
    },
  );
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
