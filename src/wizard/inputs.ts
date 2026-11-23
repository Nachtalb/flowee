// What an option of the way of working asks for before it can be on: its inputs, each a row of its follow-up screen
// with a default or suggestions as buttons, typed values or a sent file accepted. Chat-agnostic: the wizard renders
// the rows with the envoy's blocks, so every chat backend gets the same screens.
import { DEFAULTS, type FeatureName } from "../core/features";

export type InputType = "text" | "label" | "list" | "choice" | "flag" | "number";

export interface OptionInput {
  /** The option's key in the document (`features.<feature>.<key>`). */
  key: string;
  name: string;
  /** One line: what it is. */
  ask: string;
  type: InputType;
  /** `choice`: value and button label. */
  choices?: [string, string][];
  /** Values offered as buttons (a list: each its own row to add or remove). */
  suggest?: string[];
  /** Must have a value (a list: at least one entry). */
  required?: boolean;
  /** Shown (and asked) only when this holds for the current values. */
  when?: (v: Values) => boolean;
  /** One sentence when the value is not usable. */
  check?: (x: unknown, v: Values) => string | undefined;
  /** How an empty value reads (`Off`, `All of them`). */
  none?: string;
  /** A flag's line while it is off (else `ask`). */
  off?: string;
  /** Rarely needed: behind the screen's Advanced row while at its default. */
  advanced?: boolean;
}

export type Values = Record<string, unknown>;

export interface OptionSpec {
  /** The screen's question. */
  question: string;
  inputs: OptionInput[];
  /** One sentence when the values together are not usable. */
  check?: (v: Values) => string | undefined;
}

/** The options that ask for something, in the order of the options screen. `{tracker}`: GitHub or GitLab. */
export const INPUTS: Partial<Record<FeatureName, OptionSpec>> = {
  pullRequests: {
    question: "How should feature branches work?",
    inputs: [
      { key: "branch", name: "Branch name", ask: "The branch made for each ticket; {n} becomes the ticket's number.", type: "text", suggest: ["flowee/{n}", "ticket-{n}"], check: (x) => (String(x).includes("{n}") ? undefined : "The branch name needs {n}, the ticket's number.") },
      { key: "checks", name: "Required checks", ask: "The checks that must pass before a pull request is merged.", none: "All of them", type: "list" },
      { key: "method", name: "Merge method", ask: "How the pull request is merged on {tracker}.", type: "choice", choices: [["merge", "Merge"], ["squash", "Squash"], ["rebase", "Rebase"]] },
      { key: "merger", name: "Who merges", ask: "Flowee merges once the ticket passed testing, or the developer agent merges before it is tested.", type: "choice", choices: [["flow", "Flowee, after testing"], ["developer", "The developer"]] },
    ],
  },
  releases: {
    question: "How do releases work?",
    inputs: [
      { key: "hold", name: "Wait for a release", ask: "You are asked to test a ticket only once a release contains its change.", off: "You are asked right away; the request names the release once one has the change.", type: "flag" },
      { key: "source", name: "What counts as released", ask: "The newest release on {tracker}, or a git tag you move yourself (e.g. stable).", type: "choice", choices: [["release", "The newest release"], ["tag", "A git tag"]] },
      { key: "tag", name: "Release tag", ask: "The git tag you move onto each released commit.", none: "Not set yet", type: "text", suggest: ["stable", "latest"], required: true, when: (v) => v.source === "tag" },
      { key: "testedTag", name: "Mark tested code with a tag", ask: "Flowee keeps a git tag on the newest commit whose tickets all passed testing.", none: "Off", type: "text", suggest: ["tested"], advanced: true, check: (x, v) => (x && x === v.tag ? "The tag for tested code must differ from the release tag." : undefined) },
    ],
  },
  uiReview: {
    question: "Which files are UI?",
    inputs: [
      {
        key: "paths",
        name: "UI files",
        ask: "A change to one of these comes to you before its ticket is closed.",
        none: "No files yet",
        type: "list",
        suggest: ["src/components/**", "src/ui/**", "**/*.css", "**/*.html", "**/*.tsx", "**/*.vue", "**/res/layout/**"],
        required: true,
      },
    ],
  },
  dependencyTickets: {
    question: "Which update pull requests become tickets?",
    inputs: [
      { key: "authors", name: "Opened by", ask: "Pull requests from these accounts become tickets.", none: "No account yet", type: "list", suggest: ["dependabot[bot]", "renovate[bot]"], required: true },
      { key: "labels", name: "Labels", ask: "Labels each of these tickets gets.", none: "No labels", type: "list", advanced: true },
    ],
  },
  userFeedback: {
    question: "Which label marks user feedback?",
    inputs: [{ key: "label", name: "Feedback label", ask: "The label on tickets your users wrote.", none: "Not set yet", type: "label", suggest: ["feedback", "user-report"], required: true }],
  },
};

/** The values an option has now: its defaults, the document's, then what was asked. */
export function valuesOf(f: string, doc: unknown, asked: Values = {}): Values {
  const d = (DEFAULTS as unknown as Record<string, Values>)[f] ?? {};
  return { ...d, ...(doc && typeof doc === "object" ? (doc as Values) : {}), ...asked };
}

/** The inputs shown for these values. */
export const shown = (spec: OptionSpec, v: Values) => spec.inputs.filter((i) => !i.when || i.when(v));

/** Why the values cannot be used yet, one sentence (none: usable). */
export function problem(spec: OptionSpec, v: Values): string | undefined {
  for (const i of shown(spec, v)) {
    const x = v[i.key];
    const empty = x === undefined || x === "" || (Array.isArray(x) && !x.length);
    if (i.required && empty) return i.type === "list" ? `${i.name}: add at least one.` : `The ${i.name.toLowerCase()} is not set yet.`;
    const why = !empty && i.check?.(x, v);
    if (why) return why;
  }
  return spec.check?.(v);
}

/** A typed value for one input: a list takes one entry per line or comma, a number digits, a label one line. */
export function parse(i: OptionInput, text: string, old: unknown): { value: unknown } | { error: string } {
  const t = text.trim();
  if (i.type === "list") {
    const add = t.split(/[\n,]+/).map((x) => x.trim().replace(/^[-*]\s+/, "")).filter(Boolean);
    if (!add.length) return { error: `Type ${i.name.toLowerCase()}, one per line.` };
    return { value: [...new Set([...((old as string[]) ?? []), ...add])] };
  }
  if (i.type === "number") return /^\d+$/.test(t) ? { value: Number(t) } : { error: `${i.name} is a whole number.` };
  if (!t || t.includes("\n")) return { error: `Type ${i.name.toLowerCase()} on one line.` };
  return { value: t };
}

/**
 * A sent file with the values: a JSON object by key (`{"paths": ["src/ui/**"]}`), or plain lines for the input
 * being typed (else the first list), so an agent can prepare it.
 */
export function fromFile(spec: OptionSpec, text: string, typing: string | undefined, v: Values): { values: Values } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    const i = spec.inputs.find((x) => x.key === typing) ?? spec.inputs.find((x) => x.type === "list") ?? spec.inputs[0];
    const r = parse(i, text, i.type === "list" ? [] : undefined);
    return "error" in r ? r : { values: { ...v, [i.key]: r.value } };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "The file holds no JSON object of values; send one like {\"paths\": [\"src/ui/**\"]}." };
  const out = { ...v };
  for (const [k, x] of Object.entries(raw as Values)) {
    const i = spec.inputs.find((y) => y.key === k);
    if (!i) return { error: `The file names '${k}', which this option does not have; it has ${spec.inputs.map((y) => y.key).join(", ")}.` };
    const ok = i.type === "list" ? Array.isArray(x) && x.every((y) => typeof y === "string") : i.type === "flag" ? typeof x === "boolean" : i.type === "number" ? Number.isInteger(x) : i.type === "choice" ? i.choices?.some(([c]) => c === x) : typeof x === "string";
    if (!ok) return { error: `'${k}' in the file is not ${i.type === "list" ? "a list of texts" : i.type === "flag" ? "true or false" : i.type === "choice" ? `one of ${i.choices?.map(([c]) => c).join(", ")}` : "a text"}.` };
    out[k] = x;
  }
  return { values: out };
}

/** The asked values worth writing: those that differ from the option's defaults. */
export function written(f: string, v: Values): Values {
  const d = (DEFAULTS as unknown as Record<string, Values>)[f] ?? {};
  return Object.fromEntries(Object.entries(v).filter(([k, x]) => JSON.stringify(x) !== JSON.stringify(d[k]) && !(x === "" || x === undefined)));
}
