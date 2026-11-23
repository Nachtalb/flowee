// The test instance's variables and secrets: the Workers pool's bindings and the bun runtime's environment alike.
import { createHash } from "node:crypto";
import workspaces from "./workspaces.json";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const who = ["board", "dev1", "dev2", "tester", "owner"];

export const bindings: Record<string, string> = {
  FLOWEE_CONFIG: JSON.stringify(workspaces),
  GITHUB_TOKEN: "gh-test",
  TELEGRAM_BOT_TOKEN: "999:tg-test",
  PASTE_TOKEN: "paste-test",
  TG_WEBHOOK_SECRET: "hook-test",
  ...Object.fromEntries(who.map((w) => [`TOKEN_${w.toUpperCase()}`, hash(`s-${w}`)])),
  ...Object.fromEntries(who.map((w) => [`OTHER_${w.toUpperCase()}`, hash(`o-${w}`)])),
  ...Object.fromEntries(who.map((w) => [`MULTI_${w.toUpperCase()}`, hash(`m-${w}`)])),
  LIB_TOKEN: "gh-lib",
  GITLAB_TOKEN: "gl-test",
  ...Object.fromEntries(who.map((w) => [`MIX_${w.toUpperCase()}`, hash(`x-${w}`)])),
  ...Object.fromEntries(who.map((w) => [`MIXR_${w.toUpperCase()}`, hash(`y-${w}`)])),
  ...Object.fromEntries([...who, "sampler"].map((w) => [`VIEWER_${w.toUpperCase()}`, hash(`p-${w}`)])),
  ...Object.fromEntries(who.map((w) => [`DEPS_${w.toUpperCase()}`, hash(`q-${w}`)])),
  ...Object.fromEntries(who.map((w) => [`SUITE_${w.toUpperCase()}`, hash(`u-${w}`)])),
  ...Object.fromEntries(who.map((w) => [`HOOKS_${w.toUpperCase()}`, hash(`h-${w}`)])),
  ...Object.fromEntries(who.map((w) => [`RELMAIN_${w.toUpperCase()}`, hash(`r-${w}`)])),
  ...Object.fromEntries(who.map((w) => [`BRANCHY_${w.toUpperCase()}`, hash(`b-${w}`)])),
  ...Object.fromEntries(who.map((w) => [`CREW_${w.toUpperCase()}`, hash(`c-${w}`)])),
  ...Object.fromEntries(who.map((w) => [`SQUAD_${w.toUpperCase()}`, hash(`d-${w}`)])),
  ...Object.fromEntries(who.map((w) => [`DESK_${w.toUpperCase()}`, hash(`t-${w}`)])),
  ...Object.fromEntries(who.map((w) => [`TEAM_${w.toUpperCase()}`, hash(`e-${w}`)])),
  ...Object.fromEntries(who.map((w) => [`DUO_${w.toUpperCase()}`, hash(`w-${w}`)])),
  ...Object.fromEntries(who.map((w) => [`FB_${w.toUpperCase()}`, hash(`f-${w}`)])),
  HOOKS2_BOARD: hash("k-board"),
  HOOKS2_OWNER: hash("k-owner"),
  HOOKSGL_BOARD: hash("g-board"),
  HOOKSGL_OWNER: hash("g-owner"),
  FLOWEE_KEY: "key-test",
};
