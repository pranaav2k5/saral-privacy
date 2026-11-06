import { FixedWindowLimiter } from "./limiter.js";

function setup(maxKeys = 1000) {
  let now = 1_000_000;
  const limiter = new FixedWindowLimiter(() => now, maxKeys);
  return { limiter, advance: (ms: number) => (now += ms) };
}

describe("FixedWindowLimiter", () => {
  test("allows exactly the limit within a window, then refuses", () => {
    const { limiter } = setup();
    const results = Array.from({ length: 5 }, () => limiter.hit("k", 3, 60_000).allowed);
    expect(results).toEqual([true, true, true, false, false]);
  });

  test("a refusal says how many whole seconds remain until the window ends, never less than one", () => {
    const { limiter, advance } = setup();
    limiter.hit("k", 1, 60_000);
    expect(limiter.hit("k", 1, 60_000)).toEqual({ allowed: false, retryAfterSec: 60 });
    advance(59_500);
    expect(limiter.hit("k", 1, 60_000)).toEqual({ allowed: false, retryAfterSec: 1 });
    advance(499);
    expect(limiter.hit("k", 1, 60_000)).toEqual({ allowed: false, retryAfterSec: 1 });
  });

  test("the seconds to wait are rounded up, so waiting that long is always enough", () => {
    const { limiter, advance } = setup();
    limiter.hit("k", 1, 60_000);
    advance(29_500);
    expect(limiter.hit("k", 1, 60_000).retryAfterSec).toBe(31);
  });

  test("a new window starts when the old one ends, and counting starts again", () => {
    const { limiter, advance } = setup();
    limiter.hit("k", 1, 1000);
    expect(limiter.hit("k", 1, 1000).allowed).toBe(false);
    advance(1000);
    expect(limiter.hit("k", 1, 1000).allowed).toBe(true);
    expect(limiter.hit("k", 1, 1000).allowed).toBe(false);
  });

  test("a refused request does not extend the window", () => {
    const { limiter, advance } = setup();
    limiter.hit("k", 1, 1000);
    advance(900);
    limiter.hit("k", 1, 1000);
    advance(100);
    expect(limiter.hit("k", 1, 1000).allowed).toBe(true);
  });

  test("keys are counted separately", () => {
    const { limiter } = setup();
    limiter.hit("a", 1, 1000);
    expect(limiter.hit("a", 1, 1000).allowed).toBe(false);
    expect(limiter.hit("b", 1, 1000).allowed).toBe(true);
  });

  test("the same key can be given different limits, and the one passed is the one applied", () => {
    const { limiter } = setup();
    limiter.hit("k", 2, 1000);
    limiter.hit("k", 2, 1000);
    expect(limiter.hit("k", 5, 1000).allowed).toBe(true);
  });

  test("memory is bounded: when full, the oldest key is dropped and new keys are still counted", () => {
    const { limiter } = setup(3);
    for (const k of ["a", "b", "c"]) limiter.hit(k, 1, 60_000);
    expect(limiter.size).toBe(3);
    expect(limiter.hit("d", 1, 60_000).allowed).toBe(true);
    expect(limiter.size).toBe(3);
    expect(limiter.hit("d", 1, 60_000).allowed).toBe(false);
    // "a" was the oldest and has been forgotten, so it starts afresh; "c" is still counted.
    expect(limiter.hit("a", 1, 60_000).allowed).toBe(true);
    expect(limiter.hit("c", 1, 60_000).allowed).toBe(false);
  });

  test("expired keys are removed before a live key is dropped", () => {
    const { limiter, advance } = setup(2);
    limiter.hit("old", 1, 1000);
    advance(500);
    limiter.hit("live", 1, 60_000);
    advance(600);
    expect(limiter.hit("new", 1, 60_000).allowed).toBe(true);
    expect(limiter.size).toBe(2);
    expect(limiter.hit("live", 1, 60_000).allowed).toBe(false);
  });

  test("a key whose window was renewed counts as recent, so a busy key is not dropped before an idle one", () => {
    const { limiter, advance } = setup(2);
    limiter.hit("busy", 1, 1000);
    limiter.hit("idle", 1, 60_000);
    advance(1000);
    expect(limiter.hit("busy", 1, 1000).allowed).toBe(true); // its window renewed
    limiter.hit("new", 1, 60_000); // the table is full: the oldest is dropped, and that is "idle"
    expect(limiter.hit("busy", 1, 1000).allowed).toBe(false); // still counted
    expect(limiter.hit("idle", 1, 60_000).allowed).toBe(true); // forgotten
  });

  test("a flood of new keys does not make every request scan the whole table: expired keys are swept at most once a second", () => {
    const { limiter, advance } = setup(50);
    for (let i = 0; i < 50; i++) limiter.hit(`live${String(i)}`, 1, 600_000);
    const before = limiter.sweeps;
    for (let i = 0; i < 500; i++) limiter.hit(`flood${String(i)}`, 1, 600_000);
    expect(limiter.sweeps - before).toBe(1);
    advance(999);
    limiter.hit("soon", 1, 600_000);
    expect(limiter.sweeps - before).toBe(1);
    advance(1);
    limiter.hit("later", 1, 600_000);
    expect(limiter.sweeps - before).toBe(2);
    expect(limiter.size).toBe(50);
  });

  test("when full, an expired key is removed before a live one, even if the live one is older", () => {
    const { limiter, advance } = setup(2);
    limiter.hit("live", 1, 60_000);
    limiter.hit("short", 1, 1000);
    advance(1100);
    limiter.hit("new", 1, 60_000);
    expect(limiter.size).toBe(2);
    expect(limiter.hit("live", 1, 60_000).allowed).toBe(false);
  });
});
