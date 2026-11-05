import { MAX_ATTEMPTS, nextAttemptDelaySeconds } from "./schedule.js";

const middle = (): number => 0.5; // jitter factor 1.0

describe("retry schedule", () => {
  test("up to 15 attempts, then no more", () => {
    expect(MAX_ATTEMPTS).toBe(15);
    expect(nextAttemptDelaySeconds(14, middle)).toBeGreaterThan(0);
    expect(nextAttemptDelaySeconds(15, middle)).toBeNull();
    expect(nextAttemptDelaySeconds(16, middle)).toBeNull();
  });

  test("starts at about 10 seconds and doubles", () => {
    expect([1, 2, 3, 4].map((a) => nextAttemptDelaySeconds(a, middle))).toEqual([10, 20, 40, 80]);
  });

  test("never waits longer than 6 hours, and never goes down as attempts rise", () => {
    const delays = Array.from({ length: 14 }, (_, i) => nextAttemptDelaySeconds(i + 1, middle) as number);
    expect(Math.max(...delays)).toBeLessThanOrEqual(6 * 3600);
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1] as number);
    expect(delays.at(-1)).toBe(6 * 3600);
  });

  test("jitter spreads each delay between 75% and 125% and still respects the cap", () => {
    expect(nextAttemptDelaySeconds(3, () => 0)).toBe(30);
    expect(nextAttemptDelaySeconds(3, () => 1)).toBe(50);
    expect(nextAttemptDelaySeconds(14, () => 1)).toBeLessThanOrEqual(6 * 3600);
  });

  test.each([0, -1, 1.5, Number.NaN])("rejects attempt %p", (a) => {
    expect(() => nextAttemptDelaySeconds(a, middle)).toThrow(/attempt/);
  });
});
