// In-process timers in place of the Worker's cron trigger and the Durable Objects' alarms. One loop: every room's
// wake-up time (persisted, so a restart keeps it) and the minute's tick. The loop sleeps at most a minute and
// compares against the wall clock, so wake-ups missed while the process was stopped or the machine suspended run at
// once on the next turn. A room's alarm never runs twice at the same time; the tick never overlaps itself.
import type { Database } from "bun:sqlite";

const MINUTE = 60e3;

export class Scheduler {
  private due = new Map<string, number>();
  private running = new Map<string, Promise<void>>();
  private ticking?: Promise<void>;
  private lastTick = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;

  constructor(
    private db: Database,
    private alarm: (room: string) => Promise<void>,
    private tick: () => Promise<void>,
    private now = () => Date.now(),
    private log: (msg: string) => void = () => {},
  ) {
    db.run("CREATE TABLE IF NOT EXISTS alarms (room TEXT PRIMARY KEY, at INTEGER NOT NULL)");
    for (const r of db.query("SELECT room, at FROM alarms").all() as { room: string; at: number }[]) this.due.set(r.room, r.at);
  }

  /** The room's alarm at `at` unless one is due sooner (the Durable Object rule). */
  async wake(room: string, at: number) {
    const cur = this.due.get(room);
    if (cur !== undefined && cur <= at) return;
    this.due.set(room, at);
    this.db.run("INSERT OR REPLACE INTO alarms VALUES (?, ?)", [room, at]);
    if (!this.stopped && at < this.now() + MINUTE) this.arm(0);
  }

  next(room: string) {
    return this.due.get(room);
  }

  /** Removes the room's wake-up; true when there was one (the caller runs the alarm itself). */
  take(room: string) {
    if (!this.due.delete(room)) return false;
    this.db.run("DELETE FROM alarms WHERE room = ?", [room]);
    return true;
  }

  start() {
    this.stopped = false;
    this.arm(0);
  }

  private arm(ms: number) {
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (!this.stopped) this.timer = setTimeout(() => void this.turn(), Math.max(0, Math.min(ms, MINUTE)));
  }

  /** One turn: the due alarms, the tick when a minute has passed; then sleep until the next of them (≤ 1 minute). */
  async turn() {
    const now = this.now();
    for (const [room, at] of [...this.due]) if (at <= now && !this.running.has(room)) this.fire(room);
    if (now - this.lastTick >= MINUTE && !this.ticking) {
      this.lastTick = now;
      this.ticking = this.tick()
        .catch((e) => this.log(`tick failed: ${e instanceof Error ? e.message : e}`))
        .finally(() => (this.ticking = undefined));
    }
    const soonest = Math.min(this.lastTick + MINUTE, ...this.due.values());
    this.arm(soonest - this.now());
  }

  private fire(room: string) {
    this.due.delete(room);
    this.db.run("DELETE FROM alarms WHERE room = ?", [room]);
    const p = this.alarm(room)
      .catch(async (e) => {
        // a failed alarm is retried in a minute, as a Durable Object's would be
        this.log(`alarm of ${room} failed: ${e instanceof Error ? e.message : e}`);
        await this.wake(room, this.now() + MINUTE);
      })
      .finally(() => {
        this.running.delete(room);
        this.arm(0);
      });
    this.running.set(room, p);
  }

  /** Stops the loop and waits for the passes that are running. */
  async stop() {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    await Promise.all([...this.running.values(), this.ticking]);
  }

  /** Resolves when no alarm or tick is running (tests). */
  async idle() {
    while (this.running.size || this.ticking) await Promise.all([...this.running.values(), this.ticking]);
  }
}
