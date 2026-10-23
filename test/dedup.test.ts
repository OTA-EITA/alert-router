import { describe, expect, it } from "vitest";
import { Deduper } from "../src/dedup.js";

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("Deduper", () => {
  it("suppresses repeats within the window and allows them after", () => {
    const c = clock();
    const d = new Deduper(1000, c.now);
    expect(d.firstSeen("a")).toBe(true);
    c.advance(999);
    expect(d.firstSeen("a")).toBe(false);
    c.advance(1);
    expect(d.firstSeen("a")).toBe(true);
  });

  it("keeps keys independent", () => {
    const d = new Deduper(1000, clock().now);
    expect(d.firstSeen("a")).toBe(true);
    expect(d.firstSeen("b")).toBe(true);
    expect(d.firstSeen("a")).toBe(false);
  });

  it("forget lets the next attempt through", () => {
    const d = new Deduper(1000, clock().now);
    d.firstSeen("a");
    d.forget("a");
    expect(d.firstSeen("a")).toBe(true);
  });

  it("drops expired entries", () => {
    const c = clock();
    const d = new Deduper(1000, c.now);
    d.firstSeen("a");
    d.firstSeen("b");
    c.advance(1500);
    d.firstSeen("c");
    expect(d.size).toBe(1);
  });

  it("caps memory by evicting the oldest entries", () => {
    const c = clock();
    const d = new Deduper(60_000, c.now, 3);
    for (const k of ["a", "b", "c", "d"]) {
      d.firstSeen(k);
      c.advance(1);
    }
    expect(d.size).toBe(3);
    expect(d.firstSeen("a")).toBe(true); // evicted, so it is sent again
    expect(d.firstSeen("d")).toBe(false);
  });

  it("a window of zero never suppresses", () => {
    const d = new Deduper(0, clock().now);
    expect(d.firstSeen("a")).toBe(true);
    expect(d.firstSeen("a")).toBe(true);
  });
});
