import { Fail } from "./errors";

export interface Card {
  kind: "test" | "question" | "decision" | "sample";
  changed?: string;
  /** File names (feature `samples`). */
  samples?: string;
  /** The release that first had the ticket's code (feature `releases`). */
  version?: string;
  check?: string;
  question?: string;
}

const FIELD = /^(Kind|Changed|Check|Question):\s*(.*)$/;
// Lines the service itself appends after a comment (pass, handoff) are not part of the card.
const TRAILER = /^(Tested build:|Commits:)/;
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The owner card (`### <heading>`) of a comment; throws 422 bad_card naming what is missing. */
const SAMPLE_FIELD = /^(Kind|Changed|Samples|Check|Question):\s*(.*)$/;

/** Code spans the owner cannot copy as one file name: a path, or a name with more text in the span. */
function copyProblems(f: Record<string, string>, kind: string): string[] {
  const out: string[] = [];
  const text = Object.entries(f)
    .filter(([k]) => !(kind === "sample" && k === "check"))
    .map(([, v]) => v)
    .join("\n");
  for (const [, span] of text.matchAll(/`([^`\n]+)`/g)) {
    if (/[/\\]/.test(span)) out.push(`\`${span}\` is a path; give the file name only`);
    else if (/\.[A-Za-z0-9]{1,8}\s+\S/.test(span)) out.push(`only the file name goes in \`${span}\`, the note after it outside`);
  }
  for (const name of (f.samples ?? "").split(/,\s*/)) if (/[/\\]/.test(name)) out.push(`Samples: ${name} is a path; give the file name only`);
  return out;
}

/** `samples`: the workspace has the samples feature (Kind: sample, Samples:, file names only). */
export function parseCard(body: string, heading: string, samples = false): Card {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const head = new RegExp(`^#{2,4}\\s*${reEsc(heading)}\\s*$`);
  // agents address the card to a person by name whatever the workspace's heading says: such a card with a Kind: line counts too
  const named = (l: string, i: number) => /^#{2,4}\s*For\s+\S.*$/.test(l) && /^Kind:/.test(lines.slice(i + 1).find((x) => x.trim()) ?? "");
  let start = lines.findIndex((l) => head.test(l));
  if (start < 0) start = lines.findIndex(named);
  if (start < 0) throw new Fail(422, "bad_card", `The comment has no ### ${heading} card.`);
  const f: Record<string, string> = {};
  let key: string | undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line) || TRAILER.test(line)) break;
    const m = (samples ? SAMPLE_FIELD : FIELD).exec(line);
    if (m) {
      key = m[1].toLowerCase();
      f[key] = m[2].trim();
    } else if (key && line.trim()) {
      f[key] = `${f[key]}\n${line.trim()}`.trim();
    }
  }
  const kind = (f.kind ?? "").split(/\s/)[0].toLowerCase();
  if (samples && kind === "sample") {
    if (!f.samples) throw new Fail(422, "bad_card", "The card has no Samples: line (needed for Kind: sample).");
    if (!f.check) throw new Fail(422, "bad_card", "The card has no Check: lines (needed for Kind: sample).");
  } else if (kind !== "test" && kind !== "question" && kind !== "decision")
    throw new Fail(422, "bad_card", `The card's Kind: must be test, question${samples ? ", decision or sample" : " or decision"}.`);
  else if (kind === "test") {
    if (!f.changed) throw new Fail(422, "bad_card", "The card has no Changed: line (needed for Kind: test).");
    if (!f.check) throw new Fail(422, "bad_card", "The card has no Check: lines (needed for Kind: test).");
  } else if (!f.question) throw new Fail(422, "bad_card", `The card has no Question: (needed for Kind: ${kind}).`);
  const bad = samples ? copyProblems(f, kind) : [];
  if (bad.length) throw new Fail(422, "bad_card", `The owner copies file names straight from the card: ${bad.join("; ")}.`);
  return { kind: kind as Card["kind"], changed: f.changed || undefined, ...(f.samples ? { samples: f.samples } : {}), check: f.check || undefined, question: f.question || undefined };
}
