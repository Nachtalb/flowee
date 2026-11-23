// The Files port over a rustypaste-compatible upload endpoint.
import type { Files } from "../ports/files";

export class Paste implements Files {
  constructor(
    private url: string,
    private token: string | undefined,
    private expire = "90d",
  ) {}

  async upload(name: string, bytes: ArrayBuffer): Promise<string> {
    if (!this.token) throw new Error("no upload token");
    const form = new FormData();
    form.append("file", new Blob([bytes]), name);
    const up = await fetch(this.url, {
      method: "POST",
      // Cloudflare blocks default client user agents
      headers: { authorization: this.token, expire: this.expire, "user-agent": "Mozilla/5.0" },
      body: form,
    });
    const body = (await up.text()).trim();
    if (!up.ok || !body.startsWith("http")) throw new Error(`upload failed: ${up.status} ${body.slice(0, 200)}`);
    return body;
  }
}
