import { createHash } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import workspaces from "./test/workspaces.json";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const who = ["board", "dev1", "dev2", "tester", "owner"];

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          FLOWEE_CONFIG: JSON.stringify(workspaces),
          GITHUB_TOKEN: "gh-test",
          TELEGRAM_BOT_TOKEN: "999:tg-test",
          PASTE_TOKEN: "paste-test",
          TG_WEBHOOK_SECRET: "hook-test",
          ...Object.fromEntries(who.map((w) => [`TOKEN_${w.toUpperCase()}`, hash(`s-${w}`)])),
          ...Object.fromEntries(who.map((w) => [`OTHER_${w.toUpperCase()}`, hash(`o-${w}`)])),
          ...Object.fromEntries(who.map((w) => [`MULTI_${w.toUpperCase()}`, hash(`m-${w}`)])),
          LIB_TOKEN: "gh-lib",
          ...Object.fromEntries([...who, "sampler"].map((w) => [`ANYFILE_${w.toUpperCase()}`, hash(`p-${w}`)])),
          ...Object.fromEntries(who.map((w) => [`ANYDEV_${w.toUpperCase()}`, hash(`q-${w}`)])),
          FLOWEE_KEY: "key-test",
        },
      },
    }),
  ],
});
