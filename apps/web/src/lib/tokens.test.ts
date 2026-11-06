import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COLORS, TEXT_PAIRS, UI_PAIRS } from "./tokens";
import { contrastRatio } from "./contrast";

describe("contrastRatio (WCAG 2.x)", () => {
  test("black on white is 21 and a colour on itself is 1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#336699", "#336699")).toBeCloseTo(1, 5);
  });

  test("is symmetric and known pairs match published values", () => {
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#ffffff", "#777777")).toBeCloseTo(contrastRatio("#777777", "#ffffff"), 10);
  });
});

describe("the dashboard palette", () => {
  test.each(TEXT_PAIRS)("text %s on %s meets WCAG AA for body text (4.5:1)", (fg, bg) => {
    expect(contrastRatio(COLORS[fg], COLORS[bg])).toBeGreaterThanOrEqual(4.5);
  });

  test.each(UI_PAIRS)("%s against %s meets WCAG AA for interface boundaries and focus rings (3:1)", (fg, bg) => {
    expect(contrastRatio(COLORS[fg], COLORS[bg])).toBeGreaterThanOrEqual(3);
  });

  test("every colour in tokens.ts is defined in globals.css, so the checked values are the ones shipped", () => {
    const css = readFileSync(join(__dirname, "../app/globals.css"), "utf8").toLowerCase();
    for (const [name, hex] of Object.entries(COLORS)) expect({ name, shipped: css.includes(hex.toLowerCase()) }).toEqual({ name, shipped: true });
  });
});
