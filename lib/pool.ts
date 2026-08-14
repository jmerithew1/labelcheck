/**
 * A lazily-grown, bounded pool of expensive resources.
 *
 * Written for the OCR workers behind the bold gate, which were serialized
 * through a single instance: measured on the deployed app, the opt-in bold
 * pass over 250 labels resolved about four rows per minute, because every
 * measurement — and the second, full-image pass that repairs a wrong warning
 * band — queued behind every other one.
 *
 * Two properties matter more than raw parallelism here:
 *
 * - **Lazy growth.** A tesseract worker carries its own WASM heap and language
 *   data. A single-label check must not pay for four of them, so a new one is
 *   created only when every existing worker is busy and the cap has not been
 *   reached. Sequential callers therefore reuse exactly one.
 * - **Bounded, in order.** Past the cap, callers queue and are served
 *   first-come-first-served as workers come back, so a 250-row batch cannot
 *   open 250 of anything.
 *
 * Deliberately not included: idle eviction and health checks. The pool lives
 * for the life of the page, the workers are stateless between calls, and an
 * eviction timer is a second thing to get wrong for no measured gain.
 */
export interface Pool<T> {
  /** A resource held exclusively until released, or null if none can be made. */
  acquire(): Promise<T | null>;
  /** Hand back to the next waiter, or park it. ALWAYS call this in a finally. */
  release(resource: T): void;
  /** How many exist (created, not idle) — for tests and diagnostics. */
  readonly size: number;
  /** How many callers are queued for a resource. */
  readonly waiting: number;
}

export function createPool<T>({
  max,
  create,
}: {
  /** hard ceiling on live resources */
  max: number;
  /** builds one; may reject */
  create: () => Promise<T>;
}): Pool<T> {
  const idle: T[] = [];
  const waiters: ((resource: T) => void)[] = [];
  let created = 0;

  return {
    async acquire(): Promise<T | null> {
      const free = idle.pop();
      if (free !== undefined) return free;

      if (created < max) {
        created++;
        try {
          return await create();
        } catch {
          created--;
          // If nothing exists to fall back on, the caller cannot proceed.
          // (For the bold gate that means "unmeasurable", which the gate
          // already routes to a human glance — the safe direction.)
          if (created === 0 && waiters.length === 0) return null;
          // Otherwise queue behind the ones that DID start, rather than
          // failing a caller that could simply have waited a moment.
        }
      }

      return new Promise<T>((resolve) => waiters.push(resolve));
    },

    release(resource: T): void {
      const next = waiters.shift();
      if (next) next(resource);
      else idle.push(resource);
    },

    get size() {
      return created;
    },
    get waiting() {
      return waiters.length;
    },
  };
}
