// The layers stay apart: core, ports, envoy and api import no adapter and nothing of Cloudflare, GitHub or
// Telegram; nothing in src names a project, a person, a repository or a chat.
import { describe, expect, it } from "vitest";

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

  it("nothing in src names a project, a person, a repository or a chat id", () => {
    for (const [path, src] of Object.entries(files))
      expect(/livedu|nachtalb(?!\/flowee)|\bNick\b|713276361|naa\.gg/i.exec(src)?.[0], path).toBeUndefined();
  });
});
