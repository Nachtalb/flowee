// `import worker from "../src/index"` under the bun runtime (vitest.bun.config.ts): the same fetch(req, env).
import { handle } from "./cloudflare-test";

export default { fetch: (req: Request, env?: Record<string, unknown>) => handle(req, env) };
