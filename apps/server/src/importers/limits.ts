/**
 * Memory bounds shared by the history importers. Each response of a source is
 * size-limited by the adapter fetch, but an import reads many of them; the
 * budget bounds what one import keeps in memory across all of them.
 */
import { AdapterError } from '../adapters/http.js';

/** State changes one import keeps at most (all checks together). */
export const IMPORT_MAX_EVENTS = 500_000;

/** Counts the state changes an import keeps and fails once it holds more than `max`. */
export class EventBudget {
  private used = 0;

  constructor(
    private readonly system: string,
    private readonly max: number = IMPORT_MAX_EVENTS,
  ) {}

  take(n = 1): void {
    this.used += n;
    if (this.used > this.max) {
      throw new AdapterError(
        `${this.system}: more than ${this.max} state changes in the range; import a shorter range or fewer checks.`,
      );
    }
  }
}
