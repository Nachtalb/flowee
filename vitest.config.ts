import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";
import { bindings } from "./test/bindings";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: { bindings },
    }),
  ],
  // test/bun/ holds the bun runtime's own suites (bun:sqlite, timers, polling): vitest.bun.config.ts runs them
  // css: the landing page's stylesheet is read ?raw by test/served.test.ts, not emptied
  test: { exclude: [...configDefaults.exclude, "test/bun/**"], css: true },
});
