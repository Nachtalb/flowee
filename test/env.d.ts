/// <reference types="vite/client" />
import type { CloudflareEnv as InstanceEnv } from "../src/runtime/cloudflare/worker";

declare global {
  namespace Cloudflare {
    interface Env extends InstanceEnv {}
  }
}
