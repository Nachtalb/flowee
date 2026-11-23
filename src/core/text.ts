export const or = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);
export const iso = (ms: number) => new Date(ms).toISOString();

export async function sha256(s: string | ArrayBuffer): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", typeof s === "string" ? new TextEncoder().encode(s) : s));
}

export const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Constant-time string comparison through digests (lengths never leak). */
export async function same(a: string, b: string): Promise<boolean> {
  return crypto.subtle.timingSafeEqual(await sha256(a), await sha256(b));
}

/** `{name}` placeholders filled from `vars`; unknown names stay as they are. */
export const fill = (template: string, vars: Record<string, unknown>) =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined ? m : String(vars[k])));

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Removes any leading signatures (`Board:`, `Owner:` …) the caller wrote itself. */
export function stripper(signs: string[]) {
  const re = new RegExp(`^((${signs.map(reEsc).join("|")}):\\s*)+`);
  return (text: string) => text.trim().replace(re, "");
}
