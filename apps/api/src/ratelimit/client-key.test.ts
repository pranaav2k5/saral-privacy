import { clientKey } from "./client-key.js";

describe("clientKey", () => {
  test.each([
    ["203.0.113.7", "203.0.113.7"],
    ["::ffff:203.0.113.7", "203.0.113.7"],
    ["::FFFF:203.0.113.7", "203.0.113.7"],
    ["::1", "v6:0000:0000:0000:0000"],
    ["2001:db8:abcd:12::1", "v6:2001:0db8:abcd:0012"],
    ["2001:db8:abcd:12:ffff:ffff:ffff:ffff", "v6:2001:0db8:abcd:0012"],
    ["2001:DB8:ABCD:12::9", "v6:2001:0db8:abcd:0012"],
    ["fe80::1%eth0", "v6:fe80:0000:0000:0000"],
    ["2001:db8::", "v6:2001:0db8:0000:0000"],
    ["::", "v6:0000:0000:0000:0000"],
    ["1:2:3:4:5:6:1.2.3.4", "v6:0001:0002:0003:0004"],
    ["64:ff9b::1.2.3.4", "v6:0064:ff9b:0000:0000"],
  ])("%s is counted as %s", (ip, key) => {
    expect(clientKey(ip)).toBe(key);
  });

  test("addresses in the same /64 share a key, and different /64s do not", () => {
    expect(clientKey("2001:db8:1:1::a")).toBe(clientKey("2001:db8:1:1:5:6:7:8"));
    expect(clientKey("2001:db8:1:1::a")).not.toBe(clientKey("2001:db8:1:2::a"));
  });

  test("a missing or unusable address is one shared key, so it is limited together rather than not at all", () => {
    expect(clientKey(undefined)).toBe("unknown");
    expect(clientKey("")).toBe("unknown");
    expect(clientKey("not an address")).toBe("unknown");
  });
});
