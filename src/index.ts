// The Worker's entry (wrangler.toml `main`): the Cloudflare runtime (src/runtime/cloudflare). The self-hosted
// process is src/runtime/bun/main.ts; both serve the same router (src/runtime/router.ts).
export { default, Instance, Workspace } from "./runtime/cloudflare/worker";
