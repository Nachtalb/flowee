// The compiled executable's entry (scripts/compile.ts): the served material embedded, then `flowee` as main.ts.
// @ts-ignore embedded.gen.ts exists only while compiling
import { EMBEDDED } from "./embedded.gen";
import { embed } from "./app";

embed(EMBEDDED as Record<string, [string, string]>);
await import("./main");
