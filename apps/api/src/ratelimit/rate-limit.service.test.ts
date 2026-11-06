import { HttpException } from "@nestjs/common";
import { RateLimitService } from "./rate-limit.service.js";
import type { Limits } from "./policies.js";

const LIMITS: Limits = {
  ip: { limit: 100, windowMs: 60_000 },
  auth: { limit: 2, windowMs: 60_000 },
  principal: { limit: 100, windowMs: 60_000 },
};

function setup(maxKeys = 3) {
  const headers: Record<string, string> = {};
  const res = { setHeader: (name: string, value: string) => void (headers[name] = value) };
  const service = new RateLimitService(LIMITS, () => 1_000_000, maxKeys);
  const refused = (bucket: "ip" | "auth" | "principal", key: string): boolean => {
    try {
      service.check(res, bucket, key);
      return false;
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(429);
      return true;
    }
  };
  return { refused, headers };
}

describe("RateLimitService", () => {
  test("applies the limit of the bucket it is asked about", () => {
    const { refused, headers } = setup();
    expect([refused("auth", "a"), refused("auth", "a"), refused("auth", "a")]).toEqual([false, false, true]);
    expect(headers["Retry-After"]).toBe("60");
    // The same key in another bucket is counted on its own, with that bucket's limit.
    expect(refused("ip", "a")).toBe(false);
  });

  test("a flood of different addresses against the general limit cannot make the sign-in counters forget an address", () => {
    const { refused } = setup(3);
    expect(refused("auth", "attacker")).toBe(false);
    expect(refused("auth", "attacker")).toBe(false);
    expect(refused("auth", "attacker")).toBe(true);
    for (let i = 0; i < 50; i++) refused("ip", `address-${String(i)}`);
    expect(refused("auth", "attacker")).toBe(true);
  });

  test("a flood against one key's counters cannot make the counters of another bucket forget", () => {
    const { refused } = setup(3);
    for (let i = 0; i < 100; i++) refused("principal", "p1");
    expect(refused("principal", "p1")).toBe(true);
    for (let i = 0; i < 50; i++) refused("auth", `address-${String(i)}`);
    expect(refused("principal", "p1")).toBe(true);
  });
});
