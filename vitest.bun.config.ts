// The same suites on the bun runtime (`bun --bun vitest run -c vitest.bun.config.ts`, part of `bun run test`):
// `cloudflare:test` and the Worker entry resolve to test/bun/, which runs them against src/runtime/bun.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^cloudflare:test$/, replacement: at("./test/bun/cloudflare-test.ts") },
      { find: /^\.\.\/src\/index$/, replacement: at("./test/bun/worker.ts") },
    ],
  },
  test: { pool: "threads", include: ["test/**/*.test.ts"], css: true },
});
