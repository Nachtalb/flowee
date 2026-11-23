// What a user pastes for a repository in the wizard: every natural form becomes owner/name, anything else nothing.
import { describe, expect, it } from "vitest";
import { githubRepo } from "../src/adapters/tracker-github";

describe("repository references (GitHub)", () => {
  const parse = githubRepo();
  it.each([
    "acme/app",
    "https://github.com/acme/app",
    "http://github.com/acme/app",
    "https://www.github.com/acme/app",
    "https://github.com/acme/app.git",
    "https://github.com/acme/app/",
    "https://github.com/acme/app/issues/12",
    "https://github.com/acme/app/tree/main/src/x.ts",
    "https://github.com/acme/app/pull/3",
    "https://github.com/acme/app?tab=readme",
    "https://github.com/acme/app#readme",
    "github.com/acme/app",
    "www.github.com/acme/app",
    "git@github.com:acme/app.git",
    "ssh://git@github.com/acme/app.git",
    "git://github.com/acme/app",
    "  <https://github.com/acme/app>  ",
    "<acme/app>",
    "acme/app.git",
    "HTTPS://GitHub.com/acme/app",
  ])("%s", (ref) => expect(parse(ref)).toBe("acme/app"));

  it("keeps dots, dashes and case in names", () => {
    expect(parse("https://github.com/Octo-Org/my.repo_2")).toBe("Octo-Org/my.repo_2");
  });

  it.each(["acme", "https://github.com/acme", "https://gitlab.com/acme/app", "git@gitlab.com:acme/app.git", "-x/app", "acme/..", "https://github.com", "a b/c", ""])(
    "refuses %j",
    (ref) => expect(parse(ref)).toBeUndefined(),
  );

  it("an Enterprise API URL adds its host", () => {
    const ghe = githubRepo("https://git.example.com/api/v3");
    expect(ghe("https://git.example.com/acme/app/issues/1")).toBe("acme/app");
    expect(ghe("git@git.example.com:acme/app.git")).toBe("acme/app");
    expect(ghe("https://github.com/acme/app")).toBe("acme/app");
    expect(githubRepo("https://api.github.com")("https://github.com/acme/app")).toBe("acme/app");
  });
});
