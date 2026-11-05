import { WebhookUrlError, assertWebhookUrl, isPublicAddress, type Resolver } from "./url-guard.js";

const resolveTo = (...addresses: string[]): Resolver => async () => addresses;

describe("isPublicAddress", () => {
  test.each(["8.8.8.8", "93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])("%s is public", (a) => {
    expect(isPublicAddress(a)).toBe(true);
  });

  test.each([
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "169.254.0.1", "0.0.0.0", "0.1.2.3", "100.64.0.1", "100.127.255.255", "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1",
    "203.0.113.1", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
    "64:ff9b::7f00:1",
  ])("%s is not public", (a) => {
    expect(isPublicAddress(a)).toBe(false);
  });

  test.each(["", "not an address", "256.1.1.1", "1.2.3", "01.2.3.4"])("%p is not public (unparseable)", (a) => {
    expect(isPublicAddress(a)).toBe(false);
  });

  test("172.15.x and 172.32.x are outside the private range", () => {
    expect(isPublicAddress("172.15.0.1")).toBe(true);
    expect(isPublicAddress("172.32.0.1")).toBe(true);
  });
});

describe("assertWebhookUrl", () => {
  test("accepts an https URL whose every address is public", async () => {
    await expect(assertWebhookUrl("https://hooks.example.org/saral", resolveTo("93.184.216.34", "2606:4700::1111"))).resolves.toBeUndefined();
  });

  test.each([
    ["http", "http://hooks.example.org/x"],
    ["a non-web scheme", "ftp://hooks.example.org/x"],
    ["credentials", "https://user:pass@hooks.example.org/x"],
    ["a non-standard port", "https://hooks.example.org:8443/x"],
    ["not a URL", "hooks.example.org"],
    ["an empty string", ""],
    ["a very long URL", "https://hooks.example.org/" + "a".repeat(600)],
    ["a fragment-only trick", "https:///x"],
  ])("rejects %s", async (_n, url) => {
    await expect(assertWebhookUrl(url, resolveTo("93.184.216.34"))).rejects.toThrow(WebhookUrlError);
  });

  test.each(["https://127.0.0.1/x", "https://[::1]/x", "https://10.1.2.3/x", "https://169.254.169.254/latest/meta-data", "https://[::ffff:7f00:1]/x", "https://2130706433/x", "https://0x7f.1/x"])(
    "rejects the literal address in %s",
    async (url) => {
      await expect(assertWebhookUrl(url, resolveTo("93.184.216.34"))).rejects.toThrow(WebhookUrlError);
    },
  );

  test("rejects a host name that resolves to a private address, even if other answers are public", async () => {
    await expect(assertWebhookUrl("https://evil.example/x", resolveTo("93.184.216.34", "10.0.0.5"))).rejects.toThrow(/private/);
    await expect(assertWebhookUrl("https://internal.example/x", resolveTo("127.0.0.1"))).rejects.toThrow(/private/);
    await expect(assertWebhookUrl("https://localhost/x", resolveTo("93.184.216.34"))).rejects.toThrow(/fully qualified/);
  });

  test("rejects a host name that does not resolve", async () => {
    await expect(assertWebhookUrl("https://nowhere.example/x", resolveTo())).rejects.toThrow(/resolve/);
    const failing: Resolver = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(assertWebhookUrl("https://nowhere.example/x", failing)).rejects.toThrow(/resolve/);
  });
});
