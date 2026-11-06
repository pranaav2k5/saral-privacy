import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  test("defaults port to 4000", () => {
    expect(loadConfig({})).toEqual({ port: 4000 });
  });

  test("reads PORT from env", () => {
    expect(loadConfig({ PORT: "4100" })).toEqual({ port: 4100 });
  });

  test.each(["abc", "0", "70000", "-1", "4000.5", ""])("rejects invalid PORT %p", (value) => {
    expect(() => loadConfig({ PORT: value })).toThrow(/PORT/);
  });

  test("trusts no proxy unless told how many there are", () => {
    expect(loadConfig({})).toEqual({ port: 4000 });
    expect(loadConfig({ TRUST_PROXY: "0" })).toEqual({ port: 4000 });
  });

  test.each([["1", 1], ["2", 2], ["10", 10]])("reads TRUST_PROXY %p as %p proxies", (value, hops) => {
    expect(loadConfig({ TRUST_PROXY: value })).toEqual({ port: 4000, trustProxy: hops });
    expect(loadConfig({ PORT: "4100", TRUST_PROXY: value })).toEqual({ port: 4100, trustProxy: hops });
  });

  test.each(["abc", "-1", "11", "1.5", "", "true", " 1"])("rejects invalid TRUST_PROXY %p", (value) => {
    expect(() => loadConfig({ TRUST_PROXY: value })).toThrow(/TRUST_PROXY/);
  });
});
