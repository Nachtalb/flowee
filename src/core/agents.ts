// The workspace's agents as identities (docs/api.md, "Agents"): created, renamed, paused and removed through the API
// with the project key and kept in the workspace's store. Agents the document names (`roles`) count too, read-only.
import type { Store } from "../ports/store";
import type { Flow } from "./chart";
import { Fail } from "./errors";
import { hex, sha256 } from "./text";

export const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface Agent {
  name: string;
  role: string;
  /** `document`: named in the workspace document (its own secret there); `api`: created with the project key. */
  source: "api" | "document";
  paused: boolean;
  created?: number;
  seen?: number;
}

/** The agent types the flow offers: what each may do, which states it takes tickets from. */
export function roles(flow: Flow) {
  const o = flow.options;
  return Object.entries(o.roles).map(([name, r]) => {
    const claims = flow.states.filter((s) => flow.meta(s).claimable?.role === name);
    return {
      name,
      description: r.description ?? `Works as ${r.who}.`,
      commands: Object.entries(o.commands).filter(([, c]) => c.roles.includes(name)).map(([c]) => c),
      claims,
      several: r.several ?? (claims.length > 0 && name !== o.ownerRole),
    };
  });
}

type Row = { name: string; role: string; paused: number; secret: string | null; created: number };

export class Agents {
  constructor(
    private db: Store,
    private flow: Flow,
    /** The agents the document names. */
    private named: { instance: string; role: string }[],
  ) {}

  private rows = () => this.db.rows<Row>("SELECT * FROM agents ORDER BY created, name");
  private seenOf = (name: string) => Number(this.db.rows<{ v: string }>("SELECT v FROM meta WHERE k = ?", `seen:${name}`)[0]?.v) || undefined;

  /** The stored agents with a secret of their own (strict mode): SHA-256 hex digests. */
  secrets() {
    return this.rows().filter((r) => r.secret).map((r) => ({ name: r.name, role: r.role, digest: r.secret as string }));
  }

  list(): Agent[] {
    const doc: Agent[] = this.named.map((r) => ({ name: r.instance, role: r.role, source: "document", paused: false }));
    const api: Agent[] = this.rows().map((r) => ({ name: r.name, role: r.role, source: "api", paused: !!r.paused, created: r.created }));
    return [...doc, ...api].map((a) => ({ ...a, ...(this.seenOf(a.name) ? { seen: this.seenOf(a.name) } : {}) }));
  }

  get(name: string) {
    return this.list().find((a) => a.name === name);
  }

  names() {
    return this.list().map((a) => a.name);
  }

  seen(name: string, at: number) {
    this.db.exec("INSERT OR REPLACE INTO meta VALUES (?, ?)", `seen:${name}`, String(at));
  }

  private free(name: string) {
    if (!AGENT_NAME.test(name)) throw new Fail(400, "bad_request", `'${name}' is no usable agent name: lowercase letters, digits and dashes, at most 32.`);
    if (this.get(name)) throw new Fail(409, "name_taken", `The name '${name}' is taken; choose another or leave the name out.`);
  }

  /** A new agent of `role`; the name defaults to the next free one (dev1, dev2 …, board, board2 …). */
  async add(role: string, name: string | undefined, at: number, own: boolean) {
    const all = Object.keys(this.flow.options.roles);
    if (!all.includes(role)) throw new Fail(400, "unknown_role", `'${role}' is no role of this workspace's flow (${all.join(", ")}).`);
    if (name === undefined) {
      const short = role === "developer" ? "dev" : role;
      const taken = new Set(this.names());
      name = role === "developer" ? "dev1" : short;
      for (let i = 2; taken.has(name); i++) name = `${short}${i}`;
    } else this.free(name);
    const secret = own ? hex(crypto.getRandomValues(new Uint8Array(32))) : undefined;
    this.db.exec("INSERT INTO agents VALUES (?, ?, 0, ?, ?)", name, role, secret ? hex(await sha256(secret)) : null, at);
    return { agent: this.get(name) as Agent, secret };
  }

  private stored(name: string, what: string) {
    const a = this.get(name);
    if (!a) throw new Fail(404, "unknown_agent", `There is no agent '${name}'.`);
    if (a.source === "document") throw new Fail(409, "named_agent", `'${name}' is named in the workspace document; ${what} it there.`);
    return a;
  }

  /** Renames and pauses or resumes; the agent's claims and its recorded hand-overs follow a new name. */
  change(name: string, to: { name?: string; paused?: boolean }) {
    this.stored(name, "change");
    if (to.paused !== undefined) this.db.exec("UPDATE agents SET paused = ? WHERE name = ?", to.paused ? 1 : 0, name);
    if (to.name !== undefined && to.name !== name) {
      this.free(to.name);
      this.db.exec("UPDATE agents SET name = ? WHERE name = ?", to.name, name);
      this.db.exec("UPDATE claims SET instance = ? WHERE instance = ?", to.name, name);
      this.db.exec("UPDATE origins SET instance = ? WHERE instance = ?", to.name, name);
      this.db.exec("UPDATE meta SET k = ? WHERE k = ?", `seen:${to.name}`, `seen:${name}`);
      name = to.name;
    }
    return this.get(name) as Agent;
  }

  /** The agent goes; its claims expire now, so the reaper hands its tickets back as for a lapsed lease. */
  remove(name: string) {
    this.stored(name, "remove");
    const held = this.holds(name);
    this.db.exec("DELETE FROM agents WHERE name = ?", name);
    this.db.exec("DELETE FROM meta WHERE k = ?", `seen:${name}`);
    this.db.exec("UPDATE claims SET touched = 0 WHERE instance = ?", name);
    return held;
  }

  holds(name: string) {
    return this.db.rows<{ n: number }>("SELECT n FROM claims WHERE instance = ? ORDER BY n", name).map((r) => r.n);
  }
}
