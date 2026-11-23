// Telegram by long polling: one loop per bot (the standalone bot, the managed instance's bot, every workspace's own
// bot). The offset is persisted after each update is handled, so a restart neither skips nor repeats one (and the
// hosts drop an update id they have seen, as with webhook retries). Before polling the bot's webhook is deleted;
// Telegram's 409 (another process polls the same bot, or a webhook was set again) stops the loop with one sentence.
import type { Database } from "bun:sqlite";
import { Telegram } from "../../adapters/chat-telegram";

const BACKOFF = [1, 2, 5, 10, 30, 60];

export interface PollerOptions {
  db: Database;
  log: (msg: string) => void;
  /** Long-poll seconds per getUpdates (Telegram allows up to 50). */
  timeout?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const nap = (ms: number, signal: AbortSignal) =>
  new Promise<void>((ok) => {
    const t = setTimeout(ok, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), ok()), { once: true });
  });

export class Poller {
  private stop = new AbortController();
  /** Settles when the loop has ended (stopped, refused, or a handled update finished during shutdown). */
  readonly done: Promise<void>;
  state: "polling" | "conflict" | "stopped" = "polling";

  constructor(
    readonly bot: string,
    readonly token: string,
    private allowed: string[],
    private deliver: (update: { update_id: number }) => Promise<void>,
    private o: PollerOptions,
  ) {
    o.db.run("CREATE TABLE IF NOT EXISTS offsets (bot TEXT PRIMARY KEY, next INTEGER NOT NULL)");
    this.done = this.loop();
  }

  private get offset() {
    return (this.o.db.query("SELECT next FROM offsets WHERE bot = ?").get(this.bot) as { next: number } | null)?.next ?? 0;
  }

  private async loop() {
    const tg = new Telegram(this.token, `the token of the bot ${this.bot}`);
    const sleep = this.o.sleep ?? nap;
    const signal = this.stop.signal;
    let fails = 0;
    for (let ready = false; !signal.aborted; ) {
      if (!ready) {
        try {
          await tg.deleteWebhook();
          ready = true;
          this.o.log(`telegram ${this.bot}: polling for updates (no webhook)`);
        } catch (e) {
          this.o.log(`telegram ${this.bot}: deleting the webhook failed (${e instanceof Error ? e.message : e}); retrying`);
          await sleep(BACKOFF[Math.min(fails++, BACKOFF.length - 1)] * 1000, signal);
          continue;
        }
      }
      const r = await tg.updates(this.offset, this.o.timeout ?? 50, this.allowed, signal);
      if (signal.aborted) break;
      if (!r.ok) {
        if (r.conflict) {
          this.state = "conflict";
          this.o.log(`telegram ${this.bot}: another consumer holds this bot (Telegram answered 409: ${r.error}); stop the other Flowee process or remove its webhook, then restart.`);
          return;
        }
        this.o.log(`telegram ${this.bot}: getUpdates failed (${r.error}); retrying`);
        await sleep(BACKOFF[Math.min(fails++, BACKOFF.length - 1)] * 1000, signal);
        continue;
      }
      fails = 0;
      for (const u of r.updates) {
        try {
          await this.deliver(u);
        } catch (e) {
          // the same as a webhook answered 200 after a failure: the update is not retried forever
          this.o.log(`telegram ${this.bot}: update ${u.update_id} failed (${e instanceof Error ? e.message : e})`);
        }
        this.o.db.run("INSERT OR REPLACE INTO offsets VALUES (?, ?)", [this.bot, u.update_id + 1]);
        if (signal.aborted) break;
      }
    }
    this.state = "stopped";
  }

  /** Ends the loop after the update being handled. */
  async close() {
    this.stop.abort();
    await this.done;
  }
}
