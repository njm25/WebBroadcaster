/** Minimal typed event emitter. */
export class Emitter<Events extends Record<string, unknown[]>> {
  private handlers: { [K in keyof Events]?: Set<(...args: Events[K]) => void> } = {};

  on<K extends keyof Events>(event: K, fn: (...args: Events[K]) => void): () => void {
    (this.handlers[event] ??= new Set()).add(fn);
    return () => this.handlers[event]?.delete(fn);
  }

  emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    for (const fn of this.handlers[event] ?? []) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`[emitter] handler for "${String(event)}" failed`, err);
      }
    }
  }
}
