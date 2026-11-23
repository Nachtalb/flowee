// In-memory stand-ins for the GitHub REST/GraphQL API and the Telegram Bot API, served through a fetch stub.
// The Worker and its Durable Object run in the test isolate, so replacing globalThis.fetch reaches them.

type FIssue = {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  state_reason: string | null;
  labels: { name: string }[];
  assignees: { login: string }[];
  created_at: string;
  updated_at: string;
  html_url: string;
  node_id: string;
  pull_request?: unknown;
  comments: { id: number; body: string }[];
};

export class FakeGitHub {
  issues = new Map<number, FIssue>();
  main: { sha: string; message: string }[] = []; // oldest first
  status = new Map<string, string>(); // node id -> project status
  fail?: (method: string, path: string) => number | undefined;
  writes: string[] = [];
  /** The Authorization header of every request. */
  auth: string[] = [];
  /** Routes of the optional capabilities (test/fake-code.ts); answered before the routes below. */
  extra?: (method: string, path: string, body: Record<string, any>, url: URL) => Response | undefined;
  private nextComment = 1;

  constructor(public repo = "Nachtalb/livedu") {}

  owns(path: string) {
    return path.startsWith(`/repos/${this.repo}/`) || path === `/repos/${this.repo}`;
  }

  add(o: Partial<FIssue> & { state_label?: string | string[] } = {}): FIssue {
    const number = o.number ?? this.issues.size + 1;
    const labels = [o.state_label ?? []].flat().map((name) => ({ name }));
    const i: FIssue = {
      number,
      title: o.title ?? `Ticket ${number}`,
      body: o.body ?? "## Acceptance\n- works",
      state: o.state ?? "open",
      state_reason: null,
      labels: [...labels, ...(o.labels ?? [])],
      assignees: o.assignees ?? [],
      created_at: "2026-11-01T00:00:00Z",
      updated_at: o.updated_at ?? `2026-11-02T00:00:${String(number % 60).padStart(2, "0")}Z`,
      html_url: `https://github.com/${this.repo}/issues/${number}`,
      node_id: `I_${number}`,
      pull_request: o.pull_request,
      comments: [],
    };
    this.issues.set(number, i);
    return i;
  }

  commit(message: string): string {
    const sha = (this.main.length + 1).toString(16).padStart(40, "a");
    this.main.push({ sha, message });
    return sha;
  }

  label(n: number): string[] {
    return this.issues.get(n)!.labels.map((l) => l.name);
  }

  last(n: number): string {
    const c = this.issues.get(n)!.comments;
    return c[c.length - 1]?.body ?? "";
  }

  private idx(sha: string) {
    return sha === "main" || sha === "master" ? this.main.length - 1 : this.main.findIndex((c) => c.sha === sha);
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    this.auth.push(req.headers.get("authorization") ?? "");
    await new Promise((r) => setTimeout(r, 2)); // real latency lets concurrent requests interleave
    const code = this.fail?.(method, path);
    if (code) return new Response("{}", { status: code });
    const ok = (b: unknown, status = 200) => Response.json(b, { status });
    const raw = method === "GET" ? "" : await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as Record<string, any>;
    if (method !== "GET") this.writes.push(`${method} ${path}`);
    const page = Number(url.searchParams.get("page") ?? 1);
    const per = Number(url.searchParams.get("per_page") ?? 30);
    const paged = <X>(xs: X[]) => xs.slice((page - 1) * per, page * per);
    const view = (i: FIssue) => {
      const { comments, ...rest } = i;
      return rest;
    };
    let m: RegExpExecArray | null;
    const R = `/repos/${this.repo}`;
    const extra = this.extra?.(method, path, body, url);
    if (extra) return extra;

    if (path === "/graphql") {
      const q: string = body.query;
      if (q.includes("projectV2(number"))
        return ok({
          data: {
            user: {
              projectV2: {
                id: "P1",
                field: { id: "F1", options: ["Todo", "In progress", "Owner", "On hold", "Done"].map((name) => ({ id: `O:${name}`, name })) },
              },
            },
          },
        });
      if (q.includes("addProjectV2ItemById"))
        return ok({ data: { addProjectV2ItemById: { item: { id: `item:${body.variables.c}` } } } });
      if (q.includes("updateProjectV2ItemFieldValue")) {
        this.status.set(String(body.variables.i).slice(5), String(body.variables.o).slice(2));
        return ok({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "x" } } } });
      }
    }
    if (method === "GET" && path === R) return ok({ full_name: this.repo });
    if (method === "GET" && path === `${R}/issues`)
      return ok(paged([...this.issues.values()].filter((i) => i.state === url.searchParams.get("state")).map(view)));
    if (method === "POST" && path === `${R}/issues`) {
      const i = this.add({ number: this.issues.size + 1, title: body.title, body: body.body });
      i.labels = body.labels.map((name: string) => ({ name }));
      return ok(view(i), 201);
    }
    if ((m = new RegExp(`^${R}/issues/(\\d+)$`).exec(path))) {
      const i = this.issues.get(Number(m[1]));
      if (!i) return ok({ message: "Not Found" }, 404);
      if (method === "PATCH") {
        if (body.labels) i.labels = body.labels.map((name: string) => ({ name }));
        if (body.assignees) i.assignees = body.assignees.map((login: string) => ({ login }));
        for (const k of ["title", "body", "state", "state_reason"] as const) if (k in body) (i as any)[k] = body[k];
        if (body.state === "open") i.state_reason = null;
      }
      return ok(view(i));
    }
    if ((m = new RegExp(`^${R}/issues/(\\d+)/comments$`).exec(path))) {
      const i = this.issues.get(Number(m[1]))!;
      if (method === "POST") {
        const c = { id: this.nextComment++, body: body.body };
        i.comments.push(c);
        return ok(c, 201);
      }
      return ok(paged(i.comments));
    }
    if (path === `${R}/commits`)
      return ok(paged([...this.main].reverse().map((c) => ({ sha: c.sha, commit: { message: c.message } }))));
    if ((m = new RegExp(`^${R}/compare/(\\w+)\\.\\.\\.(\\w+)$`).exec(path))) {
      const [a, b] = [this.idx(m[1]), this.idx(m[2])];
      if (a < 0 || b < 0) return ok({ message: "Not Found" }, 404);
      return ok({ status: a === b ? "identical" : a < b ? "ahead" : "behind" });
    }
    return ok({ message: `fake: no route ${method} ${path}` }, 501);
  }
}

export class FakeTelegram {
  calls: { method: string; params: Record<string, any>; id?: number; bot: string }[] = [];
  /** Results of methods that answer more than true (managed bots). */
  answers: Record<string, unknown> = {
    getManagedBotToken: "777:own-token",
    replaceManagedBotToken: "777:new-token",
    getManagedBotAccessSettings: { is_access_restricted: false },
  };
  down = false;
  webhook = "";
  private id = 100;

  of(method: string) {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }

  async handle(req: Request): Promise<Response> {
    const parts = new URL(req.url).pathname.split("/");
    const method = parts.pop()!;
    const bot = parts.pop()!.replace(/^bot/, "");
    const multipart = req.headers.get("content-type")?.startsWith("multipart/");
    const params = (multipart ? Object.fromEntries(await req.formData()) : await req.json()) as Record<string, any>;
    const call: { method: string; params: Record<string, any>; id?: number; bot: string } = { method, params, bot };
    this.calls.push(call);
    if (method === "setWebhook") this.webhook = params.url;
    if (this.down) return Response.json({ ok: false, description: "Bad Gateway" }, { status: 502 });
    const result =
      method in this.answers
        ? this.answers[method]
        : method === "getWebhookInfo"
        ? { url: this.webhook }
        : method === "getFile"
          ? { file_path: `files/${params.file_id}` }
          : method.startsWith("send") || method === "editMessageText"
            ? { message_id: params.message_id ?? ++this.id }
            : true;
    if (result && typeof result === "object" && "message_id" in result) call.id = result.message_id as number;
    return Response.json({ ok: true, result });
  }

  /** The sent messages of a method with the id Telegram gave them. */
  sent(method: string) {
    return this.calls.filter((c) => c.method === method).map((c): Record<string, any> & { id: number } => ({ ...c.params, id: c.id as number }));
  }
}

/** rustypaste at f.naa.gg: keeps what was uploaded, answers its link. */
export class FakePaste {
  uploads: { name: string; body: string; auth: string | null; expire: string | null }[] = [];
  fail = false;

  async handle(req: Request): Promise<Response> {
    if (this.fail) return new Response("unauthorized", { status: 401 });
    const file = (await req.formData()).get("file") as File;
    this.uploads.push({ name: file.name, body: await file.text(), auth: req.headers.get("authorization"), expire: req.headers.get("expire") });
    return new Response(`https://f.naa.gg/${file.name}\n`);
  }
}

export function install() {
  const gh = new FakeGitHub();
  const gh2 = new FakeGitHub("acme/widget");
  const app = new FakeGitHub("acme/app");
  const lib = new FakeGitHub("acme/lib");
  const anyfile = new FakeGitHub("acme/anyfile");
  const anydev = new FakeGitHub("acme/anydev");
  const repos = [gh2, app, lib, anyfile, anydev];
  const tg = new FakeTelegram();
  const paste = new FakePaste();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const host = new URL(req.url).host;
    if (host === "api.github.com") return (repos.find((r) => r.owns(new URL(req.url).pathname)) ?? gh).handle(req);
    if (host === "assets.test") return new Response(new Uint8Array([137, 80, 78, 71]));
    if (host === "api.telegram.org" && new URL(req.url).pathname.startsWith("/file/"))
      return new Response(`bytes of ${new URL(req.url).pathname.split("/").pop()}`);
    if (host === "api.telegram.org") return tg.handle(req);
    if (host === "f.naa.gg") return paste.handle(req);
    throw new Error(`unexpected fetch ${req.url}`);
  }) as typeof fetch;
  return { gh, gh2, app, lib, anyfile, anydev, tg, paste };
}
