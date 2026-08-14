import { describe, it, expect } from "vitest";
import { createPool } from "./pool.ts";

/** A resource whose creation we can watch and control. */
function tracker(opts: { failFirst?: number } = {}) {
  let n = 0;
  const state = { creations: 0 };
  return {
    state,
    create: async () => {
      state.creations++;
      if (opts.failFirst && state.creations <= opts.failFirst) throw new Error("boom");
      return `w${++n}`;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createPool", () => {
  it("reuses one resource for sequential callers — the single-label case", async () => {
    const t = tracker();
    const pool = createPool({ max: 4, create: t.create });
    for (let i = 0; i < 5; i++) {
      const w = await pool.acquire();
      expect(w).toBe("w1");
      pool.release(w!);
    }
    expect(t.state.creations).toBe(1);
    expect(pool.size).toBe(1);
  });

  it("grows only as far as concurrent demand, never past the cap", async () => {
    const t = tracker();
    const pool = createPool({ max: 3, create: t.create });
    const held = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
    expect(new Set(held).size).toBe(3);
    expect(pool.size).toBe(3);

    // A fourth caller must wait rather than create.
    let fourth: string | null = "not yet";
    const pending = pool.acquire().then((w) => (fourth = w));
    await flush();
    expect(fourth).toBe("not yet");
    expect(pool.waiting).toBe(1);
    expect(t.state.creations).toBe(3);

    pool.release(held[0]!);
    await pending;
    expect(fourth).toBe(held[0]);
    expect(pool.size).toBe(3);
  });

  it("serves waiters in the order they queued", async () => {
    const pool = createPool({ max: 1, create: tracker().create });
    const first = (await pool.acquire())!;
    const order: string[] = [];
    const a = pool.acquire().then(() => order.push("a"));
    const b = pool.acquire().then(() => order.push("b"));
    const c = pool.acquire().then(() => order.push("c"));
    await flush();

    pool.release(first);
    await a;
    pool.release(first);
    await b;
    pool.release(first);
    await c;
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("returns null when nothing can be created at all", async () => {
    const t = tracker({ failFirst: 99 });
    const pool = createPool({ max: 2, create: t.create });
    expect(await pool.acquire()).toBeNull();
    expect(pool.size).toBe(0);
    // The failed attempt must not burn a slot — a later success still works.
    expect(await pool.acquire()).toBeNull();
    expect(t.state.creations).toBe(2);
  });

  it("queues behind a healthy worker when a later creation fails", async () => {
    // First creation succeeds, the second throws: the second caller should
    // wait for the healthy one instead of being told the pool is unusable.
    let n = 0;
    const pool = createPool({
      max: 2,
      create: async () => {
        n++;
        if (n === 2) throw new Error("boom");
        return `w${n}`;
      },
    });
    const first = (await pool.acquire())!;
    expect(first).toBe("w1");

    let second: string | null = "not yet";
    const pending = pool.acquire().then((w) => (second = w));
    await flush();
    expect(second).toBe("not yet");
    expect(pool.waiting).toBe(1);

    pool.release(first);
    await pending;
    expect(second).toBe("w1");
  });

  it("hands a released resource straight to a waiter without parking it", async () => {
    const pool = createPool({ max: 1, create: tracker().create });
    const w = (await pool.acquire())!;
    const pending = pool.acquire();
    await flush();
    expect(pool.waiting).toBe(1);
    pool.release(w);
    expect(pool.waiting).toBe(0);
    expect(await pending).toBe(w);
  });
});
