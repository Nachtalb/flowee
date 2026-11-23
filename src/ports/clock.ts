export interface Clock {
  now(): number;
  /** Calls the workspace's `alarm()` in `ms` (unless a call is due sooner). */
  wake(ms: number): Promise<void>;
}
