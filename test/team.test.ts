// A workspace whose tickets appear in a group or topic: a team works the inbox. Every member there may answer (or
// only `chat.members`), the ticket records who answered (`texts.memberSign`), the first answer wins.
import { beforeEach, describe, expect, it } from "vitest";
import type { FakeGitHub, FakeTelegram } from "./fake";
import { CARD_Q, call, hook, setup, wipe } from "./helpers";

let crew: FakeGitHub;
let squad: FakeGitHub;
let tg: FakeTelegram;
let uid = 900000;
beforeEach(async () => {
  ({ crew, squad, tg } = setup());
  await wipe("crew");
  await wipe("squad");
});

const BOT = { id: 999, is_bot: true, first_name: "Envoy" };
const person = (id: number, first_name: string, username?: string) => ({ id, is_bot: false, first_name, ...(username ? { username } : {}) });
const reply = (chat: number, from: ReturnType<typeof person>, card: number, text: string, topic?: number) => ({
  update_id: ++uid,
  message: {
    message_id: uid,
    from,
    chat: { id: chat, type: "supergroup", title: "Team", ...(topic ? { is_forum: true } : {}) },
    date: 1,
    text,
    reply_to_message: { message_id: card, from: BOT },
    ...(topic ? { message_thread_id: topic, is_topic_message: true } : {}),
  },
});
const escalate = async (gh: FakeGitHub, n: number, prefix: string) => {
  gh.add({ number: n, state_label: "board review" });
  await call("board", "escalate", { n, comment: CARD_Q.replace("For Ann", "For the owner") }, undefined, prefix);
  return tg.sent("sendRichMessage").at(-1)?.id as number;
};

describe("a team in a group", () => {
  it("with chat.members: only those members answer; the owner too; anyone else is not heard", async () => {
    const card = await escalate(crew, 1, "c");
    await hook(reply(-100902, person(303, "Eve"), card, "Red."));
    expect(crew.issues.get(1)?.comments.length).toBe(1);
    await hook(reply(-100902, person(302, "Dan", "dan"), card, "Blue."));
    expect(crew.last(1)).toBe("Dan (@dan): Blue.");
    const card2 = await escalate(crew, 2, "c");
    await hook(reply(-100902, person(424242, "Ann"), card2, "Green."));
    expect(crew.last(2)).toBe("Ann: Green.");
  });

  it("in a topic: every member there answers, signed as texts.memberSign says; other topics are not heard", async () => {
    const card = await escalate(squad, 1, "d");
    expect(tg.sent("sendRichMessage").at(-1)).toMatchObject({ chat_id: "-100903", message_thread_id: 4 });
    await hook(reply(-100903, person(310, "Fay"), card, "Yes.", 5));
    expect(squad.issues.get(1)?.comments.length).toBe(1);
    await hook(reply(-100903, person(310, "Fay"), card, "Yes.", 4));
    expect(squad.last(1)).toBe("Fay via chat: Yes.");
    // the first answer wins: the next one is refused in one sentence, the ticket unchanged
    await hook(reply(-100903, person(311, "Gus"), card, "No.", 4));
    expect(squad.issues.get(1)?.comments.length).toBe(2);
    expect(tg.of("sendMessage").at(-1)).toMatchObject({ chat_id: "-100903", text: "⚠️ #1 was already answered by Fay via chat; yours was not recorded." });
    // the one who answered may add to it
    await hook(reply(-100903, person(310, "Fay"), card, "Also fast.", 4));
    expect(squad.last(1)).toBe("Fay via chat: Also fast.");
  });

  it("✅ OK pressed by a member is signed with the member's name; a second press hears who was first", async () => {
    const card = await escalate(squad, 2, "d");
    const press = (from: ReturnType<typeof person>) => ({
      update_id: ++uid,
      callback_query: { id: `q${uid}`, from, data: "k", message: { message_id: card, message_thread_id: 4, chat: { id: -100903 } } },
    });
    await hook(press(person(312, "Hal", "hal")));
    expect(squad.last(2)).toBe("Hal via chat: OK");
    await hook(press(person(313, "Ivy")));
    expect(tg.of("answerCallbackQuery").at(-1)?.text).toBe("#2 was already answered by Hal via chat");
  });
});
