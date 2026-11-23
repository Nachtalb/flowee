// Secrets entered in the chat (tracker and bot tokens, agent digests), sealed with AES-GCM under a key derived
// from the Worker secret FLOWEE_KEY. Sealed values live in Durable Object storage; plain ones only in memory.
const enc = new TextEncoder();
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const keys = new Map<string, Promise<CryptoKey>>();

export function vaultKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret) throw new Error("the managed mode needs the Worker secret FLOWEE_KEY");
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle.digest("SHA-256", enc.encode(secret)).then((h) => crypto.subtle.importKey("raw", h, "AES-GCM", false, ["encrypt", "decrypt"]));
    keys.set(secret, k);
  }
  return k;
}

export async function seal(key: CryptoKey, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain)));
  return `v1.${b64(iv)}.${b64(ct)}`;
}

export async function unseal(key: CryptoKey, sealed: string): Promise<string> {
  const [, iv, ct] = sealed.split(".");
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ct)));
}

/** A random secret: 32 bytes as hex. */
export const randomSecret = () => [...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, "0")).join("");
