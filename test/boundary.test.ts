// The layers stay apart: core, ports, envoy and api import no adapter and nothing of Cloudflare, Bun, GitHub or
// Telegram; only src/runtime/cloudflare imports cloudflare:*, only src/runtime/bun imports bun:*; nothing in src
// names a project, a person, a repository or a chat.
import { describe, expect, it } from "vitest";
import fixtures from "./workspaces.json";

const files = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const imports = (src: string) => [...src.matchAll(/^\s*(?:import|export)[^"']*from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
const layer = (path: string) => path.replace("../src/", "").split("/")[0];

describe("architecture boundaries", () => {
  it("sees the source tree", () => {
    expect(Object.keys(files).length).toBeGreaterThan(15);
  });

  it("core imports only core and ports; ports only ports and core errors", () => {
    for (const [path, src] of Object.entries(files)) {
      const l = layer(path);
      for (const i of imports(src)) {
        if (l === "core") expect(i.startsWith("./") || i.startsWith("../ports/"), `${path} imports ${i}`).toBe(true);
        if (l === "ports") expect(i.startsWith("./") || i === "../core/errors", `${path} imports ${i}`).toBe(true);
      }
    }
  });

  it("only a runtime's own directory imports its platform: cloudflare:* in src/runtime/cloudflare, bun:* in src/runtime/bun", () => {
    const dir = (path: string) => /^\.\.\/src\/runtime\/(cloudflare|bun)\//.exec(path)?.[1];
    for (const [path, src] of Object.entries(files))
      for (const i of imports(src)) {
        if (i.startsWith("cloudflare:")) expect(dir(path), `${path} imports ${i}`).toBe("cloudflare");
        if (i.startsWith("bun:") || i === "bun") expect(dir(path), `${path} imports ${i}`).toBe("bun");
        // one runtime never reaches into the other; only the entry and the runtimes import a runtime
        const r = /runtime\/(cloudflare|bun)\//.exec(i)?.[1] ?? (dir(path) && /^\.\.?\/(cloudflare|bun)\//.exec(i)?.[1]);
        if (r && dir(path) !== r) expect(path === "../src/index.ts" && r === "cloudflare", `${path} imports ${i}`).toBe(true);
      }
    // the platform APIs by name, not only by import (Bun.* is a global)
    for (const [path, src] of Object.entries(files)) {
      if (!dir(path)) expect(/\bBun\.\w|DurableObjectState|ctx\.storage/.test(src), path).toBe(false);
    }
  });

  it("no layer but adapters, runtime (and the entry) imports an adapter, cloudflare:* or a platform API", () => {
    for (const [path, src] of Object.entries(files)) {
      const l = layer(path);
      if (l === "adapters" || l === "runtime" || l === "index.ts") continue;
      for (const i of imports(src)) {
        expect(i.includes("adapters/"), `${path} imports ${i}`).toBe(false);
        expect(i.startsWith("cloudflare:"), `${path} imports ${i}`).toBe(false);
      }
      if (l !== "config") expect(/api\.github\.com|api\.telegram\.org|DurableObject|SqlStorage/.test(src), path).toBe(false);
    }
  });

  it("the envoy and the api do not import config or each other's internals beyond the core", () => {
    for (const [path, src] of Object.entries(files)) {
      if (!["envoy", "api"].includes(layer(path))) continue;
      for (const i of imports(src)) expect(/^\.\.\/(core|ports)\/|^\.\//.test(i), `${path} imports ${i}`).toBe(true);
    }
  });

  it("the wizard imports only core, ports, config types, the envoy's rendering and itself", () => {
    for (const [path, src] of Object.entries(files)) {
      if (layer(path) !== "wizard") continue;
      for (const i of imports(src)) expect(/^\.\.\/(core|ports|config)\/|^\.\.\/envoy\/render$|^\.\//.test(i), `${path} imports ${i}`).toBe(true);
      expect(/sendMessage|request_managed_bot|setMySettings|api\.telegram/.test(src), path).toBe(false);
    }
  });

  it("the terminal client imports of src only the ports (the protocol's and the views' types)", () => {
    const tui = import.meta.glob("../tui/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    expect(Object.keys(tui).length).toBeGreaterThan(4);
    for (const [path, src] of Object.entries(tui)) for (const i of imports(src)) if (i.startsWith("../")) expect(i.startsWith("../src/ports/"), `${path} imports ${i}`).toBe(true);
  });

  it("nothing in src names a project, a person, a repository or a chat id", () => {
    // the test workspaces stand for real ones: none of their repositories, people or chats may leak into the code
    const named = (fixtures.workspaces as any[]).flatMap((w) => [
      ...w.tracker.repos.map((r: any) => (typeof r === "string" ? r : r.repo)),
      ...w.owners.flatMap((o: any) => [o.name, o.tracker, o.chat]),
      w.chat?.chatId,
      w.chat?.username,
      w.files && new URL(w.files.url).host,
    ]);
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const re = new RegExp(`\\b(${[...new Set(named.filter((x): x is string => !!x))].map(esc).join("|")})\\b|nachtalb(?!\\/flowee)`, "i");
    for (const [path, src] of Object.entries(files)) expect(re.exec(src)?.[0], path).toBeUndefined();
  });
});
