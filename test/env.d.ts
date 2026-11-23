/// <reference types="vite/client" />
import type { Env as InstanceEnv } from "../src/adapters/instance";

declare global {
  namespace Cloudflare {
    interface Env extends InstanceEnv {}
  }
}
