/** Secrets by name (Worker secrets). Configuration documents only ever hold these names, never values. */
export interface Secrets {
  get(name: string): string | undefined;
}
