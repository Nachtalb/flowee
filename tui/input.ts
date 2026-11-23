// Keys, mouse and paste from the terminal's input bytes (xterm sequences, SGR mouse, bracketed paste).

export type Key = { type: "key"; name: string; ch?: string; ctrl?: boolean; alt?: boolean; shift?: boolean };
export type Mouse = { type: "mouse"; x: number; y: number; action: "down" | "up" | "wheelup" | "wheeldown" | "drag"; button: number };
export type Paste = { type: "paste"; text: string };
export type Input = Key | Mouse | Paste;

const CSI: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "backtab", P: "f1" };
const TILDE: Record<string, string> = { "1": "home", "2": "insert", "3": "delete", "4": "end", "5": "pageup", "6": "pagedown", "7": "home", "8": "end", "11": "f1", "15": "f5" };

/** Every input in `s`; `rest` is an incomplete sequence to prepend to the next chunk. */
export function parseInput(s: string): { events: Input[]; rest: string } {
  const out: Input[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (s.startsWith("\x1b[200~", i)) {
      const end = s.indexOf("\x1b[201~", i + 6);
      if (end < 0) return { events: out, rest: s.slice(i) };
      out.push({ type: "paste", text: s.slice(i + 6, end).replace(/\r\n?/g, "\n") });
      i = end + 6;
      continue;
    }
    if (c === "\x1b") {
      if (i + 1 >= s.length) {
        out.push({ type: "key", name: "escape" });
        i++;
        continue;
      }
      const n = s[i + 1];
      if (n === "[" || n === "O") {
        const m = /^\x1b[[O](<?)([\d;]*)([A-Za-z~])/.exec(s.slice(i));
        if (!m) {
          if (s.length - i < 16 && !/[A-Za-z~]/.test(s.slice(i + 2))) return { events: out, rest: s.slice(i) };
          out.push({ type: "key", name: "escape" });
          i++;
          continue;
        }
        i += m[0].length;
        const nums = m[2].split(";").filter(Boolean).map(Number);
        if (m[1] === "<" && (m[3] === "M" || m[3] === "m")) {
          const [b, x, y] = nums;
          const wheel = b & 64;
          const action = wheel ? (b & 1 ? "wheeldown" : "wheelup") : m[3] === "m" ? "up" : b & 32 ? "drag" : "down";
          out.push({ type: "mouse", x: x - 1, y: y - 1, action, button: b & 3 });
          continue;
        }
        const mod = nums[1] ?? 1;
        const flags = { ...(mod & 4 ? { ctrl: true } : {}), ...(mod & 2 ? { alt: true } : {}), ...(mod & 1 && mod > 1 ? { shift: true } : {}) };
        const name = m[3] === "~" ? TILDE[String(nums[0])] : CSI[m[3]];
        if (name) out.push({ type: "key", name, ...flags, ...(m[3] === "Z" ? { shift: true } : {}) });
        continue;
      }
      // Alt+key
      i += 2;
      if (n === "\r") out.push({ type: "key", name: "enter", alt: true });
      else if (n === "\x7f") out.push({ type: "key", name: "backspace", alt: true });
      else out.push({ type: "key", name: n.toLowerCase(), ch: n, alt: true });
      continue;
    }
    const code = c.charCodeAt(0);
    i++;
    if (c === "\r" || c === "\n") out.push({ type: "key", name: "enter" });
    else if (c === "\t") out.push({ type: "key", name: "tab" });
    else if (c === "\x7f" || c === "\b") out.push({ type: "key", name: "backspace" });
    else if (code === 0) out.push({ type: "key", name: "space", ctrl: true });
    else if (code < 27) out.push({ type: "key", name: String.fromCharCode(code + 96), ctrl: true });
    else if (code < 32) continue;
    else {
      // a whole code point (surrogate pairs)
      const cp = s.codePointAt(i - 1) ?? code;
      const ch = String.fromCodePoint(cp);
      if (ch.length === 2) i++;
      out.push({ type: "key", name: ch === " " ? "space" : ch.length === 1 && /[A-Za-z]/.test(ch) ? ch.toLowerCase() : ch, ch, ...(ch !== ch.toLowerCase() ? { shift: true } : {}) });
    }
  }
  return { events: out, rest: "" };
}
