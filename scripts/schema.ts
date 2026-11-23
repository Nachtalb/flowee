// Writes schema/workspace.schema.json from src/config/schema.ts (a test fails when they differ).
import { INSTANCE, SCHEMA } from "../src/config/schema";

declare const Bun: { write(path: string, data: string): Promise<number> };

await Bun.write("schema/workspace.schema.json", `${JSON.stringify(SCHEMA, null, 2)}\n`);
console.log("schema/workspace.schema.json written");
await Bun.write("schema/instance.schema.json", `${JSON.stringify(INSTANCE, null, 2)}\n`);
