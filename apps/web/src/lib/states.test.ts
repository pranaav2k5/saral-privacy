import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STATES, TYPES, nextStates, stateLabel, typeLabel } from "./states";

describe("rights request states", () => {
  test("the moves offered are exactly the API's state machine (read from apps/api/src/dsr/state.ts, so the two cannot drift)", () => {
    const src = readFileSync(join(__dirname, "../../../api/src/dsr/state.ts"), "utf8");
    const block = src.slice(src.indexOf("const NEXT"), src.indexOf("};", src.indexOf("const NEXT")));
    const api: Record<string, string[]> = {};
    for (const m of block.matchAll(/^\s+(\w+):\s*\[([^\]]*)\]/gm)) {
      api[m[1] as string] = (m[2] as string).split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
    }
    expect(Object.keys(api).sort()).toEqual([...STATES].sort());
    for (const s of STATES) expect({ s, to: [...nextStates(s)] }).toEqual({ s, to: api[s] });
  });

  test("the five types match the Act's rights and every state and type has a plain label", () => {
    expect([...TYPES]).toEqual(["access", "correction", "erasure", "nomination", "grievance"]);
    for (const s of STATES) expect(stateLabel(s)).toMatch(/^[A-Z]/);
    for (const t of TYPES) expect(typeLabel(t)).toMatch(/^[A-Z]/);
    expect(stateLabel("identity_pending")).toBe("Checking identity");
  });
});
