// The layers stay apart: core, ports, envoy and api import no adapter and nothing of Cloudflare, GitHub or
// Telegram; nothing in src names a project, a person, a repository or a chat.
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

  it("no layer but adapters (and the entry) imports an adapter, cloudflare:* or a platform API", () => {
    for (const [path, src] of Object.entries(files)) {
      const l = layer(path);
      if (l === "adapters" || l === "index.ts") continue;
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

  it("nothing in src names a project, a person, a repository or a chat id", () => {
    // the test workspaces stand for real ones: none of their repositories, people or chats may leak into the code
    const named = (fixtures.workspaces as any[]).flatMap((w) => [
      ...w.tracker.repos.map((r: any) => (typeof r === "string" ? r : r.repo)),
      ...w.owners.flatMap((o: any) => [o.name, o.tracker, o.chat]),
      w.chat?.chatId,
      w.chat?.username,
    ]);
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const re = new RegExp(`\\b(${[...new Set(named.filter((x): x is string => !!x))].map(esc).join("|")})\\b|nachtalb(?!\\/flowee)|naa\\.gg`, "i");
    for (const [path, src] of Object.entries(files)) expect(re.exec(src)?.[0], path).toBeUndefined();
  });
});
