// The wording rules of docs/chat-style.md ("Wording") as checks over a screen's text, used by every test that sees
// the screens (test/managed.test.ts over each payload, test/setup-chart.test.ts over each screen of its walks).
import { expect } from "vitest";

/**
 * Sentences that explain how to use the interface on the interface ("never explain how to use the interface"): a
 * settings screen explains itself by its rows, their values and their buttons. Extend the list when one slips in.
 */
export const INSTRUCTIONS: RegExp[] = [
  /\b(tap|press|click) (a|any|the) (value|button|switch|row)\b/i,
  /\btype your own\b/i,
  /\bas your next message\b/i,
  /\bor (send|sent) a (<code>)?\.json(<\/code>)? or text file\b/i,
  /\ban agent can prepare\b/i,
  /\bkeeps what is shown\b/i,
  /\bchoose one\.(?!\w)/i,
  /\beach switch works on its own\b/i,
  /\basks for them next\b/i,
  /\byou can change (them|it|this) later\b/i,
  /\bhere you see them\b/i,
];

/**
 * Internal terms a screen must not use (docs/chat-style.md, "Glossary": the few terms that are allowed). Say what
 * happens for the user and name the thing by what the user knows. Extend the list when one slips in.
 */
export const JARGON: RegExp[] = [
  /\btest cards?\b/i,
  /\btested tag\b/i,
  /\brelease source\b/i,
  /\bhold test\b/i,
  /\bmoves? (it )?forward\b/i,
  /\bpublished (version|build)\b/i,
  /\btriaged?\b/i,
  /\bon the pass\b/i,
  /\bhand-?off\b/i,
  /\bbinding\b/i,
  /\binstance bot\b/i,
  /\bslots?\b/i,
  /\bpresets?\b/i,
  /\bchart\b/i,
  /\bversioning\b/i,
  /\bsuggested\b/i,
  /\bNow: none\b/i,
];

/** The screen's text without markup. */
const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** Fails on a screen that narrates its own use or uses an internal term (links and code spans are not words). */
export function wording(html: string) {
  // a document's own field names in a JSON path (`$.flow.preset: …`) are the document's words, not the screen's
  const t = plain(html.replace(/<code>.*?<\/code>/g, " ").replace(/<a [^>]*>.*?<\/a>/g, " ")).replace(/\$[\w.[\]]*/g, " ");
  for (const re of INSTRUCTIONS) expect(t, `an instruction on the screen (${re})`).not.toMatch(re);
  for (const re of JARGON) expect(t, `an internal term on the screen (${re})`).not.toMatch(re);
}
