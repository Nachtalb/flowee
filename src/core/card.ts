import { Fail } from "./errors";

export interface Card {
  kind: "test" | "question" | "decision";
  changed?: string;
  check?: string;
  question?: string;
}

const FIELD = /^(Kind|Changed|Check|Question):\s*(.*)$/;
// Lines the service itself appends after a comment (pass, handoff) are not part of the card.
const TRAILER = /^(Tested build:|Commits:)/;
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The owner card (`### <heading>`) of a comment; throws 422 bad_card naming what is missing. */
export function parseCard(body: string, heading: string): Card {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const head = new RegExp(`^#{2,4}\\s*${reEsc(heading)}\\s*$`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) throw new Fail(422, "bad_card", `The comment has no ### ${heading} card.`);
  const f: Record<string, string> = {};
  let key: string | undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line) || TRAILER.test(line)) break;
    const m = FIELD.exec(line);
    if (m) {
      key = m[1].toLowerCase();
      f[key] = m[2].trim();
    } else if (key && line.trim()) {
      f[key] = `${f[key]}\n${line.trim()}`.trim();
    }
  }
  const kind = (f.kind ?? "").split(/\s/)[0].toLowerCase();
  if (kind !== "test" && kind !== "question" && kind !== "decision")
    throw new Fail(422, "bad_card", "The card's Kind: must be test, question or decision.");
  if (kind === "test") {
    if (!f.changed) throw new Fail(422, "bad_card", "The card has no Changed: line (needed for Kind: test).");
    if (!f.check) throw new Fail(422, "bad_card", "The card has no Check: lines (needed for Kind: test).");
  } else if (!f.question) throw new Fail(422, "bad_card", `The card has no Question: (needed for Kind: ${kind}).`);
  return { kind, changed: f.changed || undefined, check: f.check || undefined, question: f.question || undefined };
}
