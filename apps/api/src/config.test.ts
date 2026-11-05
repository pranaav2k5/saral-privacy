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
});
