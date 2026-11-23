// bun run validate <file>…: checks workspace or instance documents with the Worker's own validator, as `flowee validate`.
// Prints `ok <file>: <ids>` or one problem per line; exit 0 all valid, 1 a problem, 2 usage or unreadable.
import { validate } from "../src/runtime/bun/validate";

declare const process: { argv: string[]; exit(code: number): never };

process.exit(validate(process.argv.slice(2), console.log, console.error));
