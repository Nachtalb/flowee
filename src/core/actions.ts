// Named actions a chart may use. docs/flows.md describes each one.
import type { Card } from "./card";
import { CODE_ACTIONS, firstVersion } from "./code";
import type { Action } from "./engine";
import type { IssuePatch } from "../ports/tracker";
import { fill, iso } from "./text";

export const ACTIONS: Record<string, Action> = {
  ...CODE_ACTIONS,
  async setStatus(c) {
    const status = c.f.flow.meta(c.to).status;
    if (c.to !== c.from && status && c.f.tracker.board) await c.f.tracker.board.setStatus(c.t.issue, status);
  },

  async comment(c, p) {
    const vars = {
      n: c.f.ref(c.t.n),
      build: c.input.build,
      gates: (c.input.gates as { sha?: string } | undefined)?.sha,
      commits: ((c.data.commits as string[]) ?? []).join(" "),
      claim: c.data.claim,
      lease: c.f.flow.options.leaseHours,
      pull: "",
      merge: "",
      ui: "",
      paths: "",
      ...(c.data.vars as Record<string, string> | undefined),
    };
    let text = p.text ? fill(String(p.text), vars) : String(c.input[String(p.field ?? "comment")] ?? "");
    if (p.append) text += fill(String(p.append), vars);
    if (!text.trim()) return;
    c.data.commentId = await c.f.tracker.comment(c.t.n, c.f.sign(c.caller.role, text, c.data.signature as string | undefined));
  },

  /** Labels, assignee and open/closed of the target state, in one write (the label last, as the contract asks). */
  async setLabel(c, p) {
    if (c.to === c.from) return;
    const flow = c.f.flow;
    const labels = new Set(flow.states.map((s) => flow.meta(s).label).filter(Boolean));
    const m = flow.meta(c.to);
    const next = c.t.issue.labels.filter((l) => !labels.has(l));
    if (m.label && !m.closed) next.push(m.label);
    const owner = c.f.s.ownerLogin;
    const assignees = c.t.issue.assignees.filter((a) => a !== owner);
    if (m.assignOwner && owner) assignees.push(owner);
    const patch: IssuePatch = { labels: next, assignees };
    if (m.closed) Object.assign(patch, { open: false, reason: (p.reason as IssuePatch["reason"]) ?? "completed" });
    else if (!c.t.issue.open) patch.open = true;
    await c.f.tracker.update(c.t.n, patch, `the label change of ${c.f.label(c.t.n)}`);
  },

  async updateBody(c) {
    const title = c.input.title as string | undefined;
    await c.f.tracker.update(c.t.n, title ? { body: String(c.input.body), title } : { body: String(c.input.body) }, `the body of ${c.f.label(c.t.n)}`);
  },

  claim(c) {
    const now = c.f.clock.now();
    c.f.db.exec("INSERT OR REPLACE INTO claims VALUES (?, ?, ?, ?, ?)", c.t.n, c.caller.instance, c.caller.role, now, now);
  },

  releaseClaim(c) {
    c.f.db.exec("DELETE FROM claims WHERE n = ?", c.t.n);
  },

  touchClaim(c) {
    const now = c.f.clock.now();
    c.f.db.exec("UPDATE claims SET touched = ? WHERE n = ?", now, c.t.n);
    c.out.touched = iso(now);
  },

  recordOrigin(c, p) {
    c.f.db.exec("INSERT OR REPLACE INTO origins VALUES (?, ?, ?, ?)", c.t.n, String(p.from ?? c.from), c.caller.instance, c.f.clock.now());
  },

  clearOrigin(c) {
    c.f.db.exec("DELETE FROM origins WHERE n = ?", c.t.n);
  },

  recordHanded(c) {
    const commits = (c.data.commits as string[]) ?? [];
    for (const s of commits) c.f.db.exec("INSERT OR IGNORE INTO handed VALUES (?, ?)", c.t.n, s);
    c.out.commits = commits;
  },

  async recordAnswer(c, p) {
    const words = String(c.input[String(p.field ?? "text")] ?? "");
    c.f.db.exec("INSERT INTO answers (n, ts, text, via) VALUES (?, ?, ?, ?)", c.t.n, c.f.clock.now(), c.f.strip(words), String(c.data.via ?? "api"));
    if (c.f.envoy?.markAnswered(c.t.n)) await c.f.envoy.closeCards(c.t.n);
  },

  /** The ticket becomes an inbox item and its card goes to the owner's chat; `field` in the response says how. */
  async sendCard(c, p) {
    const r = c.f.s.features.releases;
    const version = r?.versionLine && (c.data.card as Card).kind === "test" ? await firstVersion(c.f, c.t) : null;
    const card = { ...(c.data.card as Card), ...(version ? { version } : {}) };
    c.f.db.exec("DELETE FROM claims WHERE n = ?", c.t.n);
    c.f.db.exec(
      "INSERT OR REPLACE INTO inbox (n, comment_id, kind, card, title, url, status, ts) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)",
      c.t.n,
      (c.data.commentId as number | undefined) ?? null,
      card.kind,
      JSON.stringify(card),
      c.t.issue.title,
      c.t.issue.url,
      c.f.clock.now(),
    );
    const sent = c.f.envoy
      ? await c.f.envoy.sendCard(c.t.n).catch((e) => {
          console.error("card", c.t.n, e);
          return "queued" as const;
        })
      : "queued";
    c.out[String(p.field ?? "chat")] = sent;
  },

  /** The ticket left the inbox by someone else's hand: its card leaves the todo list. */
  dropInboxCard(c) {
    c.f.db.exec("UPDATE inbox SET status = 'gone' WHERE n = ? AND status IN ('queued', 'sent')", c.t.n);
  },
};
