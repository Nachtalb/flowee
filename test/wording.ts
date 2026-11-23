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
];

/** The screen's text without markup. */
const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** Fails on a screen that narrates its own use. */
export function wording(html: string) {
  const t = plain(html);
  for (const re of INSTRUCTIONS) expect(t, `an instruction on the screen (${re})`).not.toMatch(re);
}
