/**
 * The in-memory log destination behind the Logs page (spec #42): the last N records as they
 * were written to stdout (pino JSON objects), plus live subscribers. Nothing touches disk;
 * the buffer is lost on restart.
 */

/** One record in the shape written to stdout: `{ level, time, msg, runId?, component?, ... }`. */
export type BufferedRecord = Record<string, unknown>;

export const LOG_BUFFER_SIZE = 2000;

export class LogBuffer {
  private records: BufferedRecord[] = [];
  private readonly listeners = new Set<(record: BufferedRecord) => void>();

  constructor(private readonly capacity = LOG_BUFFER_SIZE) {}

  push(record: BufferedRecord): void {
    this.records.push(record);
    if (this.records.length > this.capacity) this.records.splice(0, this.records.length - this.capacity);
    for (const listener of this.listeners) listener(record);
  }

  /** The buffered records, oldest first (a copy). */
  snapshot(): BufferedRecord[] {
    return [...this.records];
  }

  /** Calls `listener` with every record pushed from now on; returns the unsubscribe function. */
  subscribe(listener: (record: BufferedRecord) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}
