/**
 * The dashboard palette. These hex values are the ones in `app/globals.css` (a test checks that every one appears there),
 * and the pairs below are the combinations the screens actually use (a test checks their contrast).
 */
export const COLORS = {
  blotter: "#eef2f4",
  sheet: "#ffffff",
  ink: "#1b2a41",
  inkSoft: "#4a5a70",
  rule: "#c9d3da",
  field: "#6b7a8a",
  action: "#0f5c6e",
  stamp: "#a8321f",
  overdueFg: "#8a2415",
  overdueBg: "#fbeae7",
  okFg: "#1d6236",
  okBg: "#e4f1e8",
  soonFg: "#74460a",
  soonBg: "#fdf0d5",
  neutralFg: "#35435a",
  neutralBg: "#e3e9ee",
} as const;

export type ColorName = keyof typeof COLORS;

/** Text on its background: WCAG AA needs 4.5 to 1. */
export const TEXT_PAIRS: readonly (readonly [ColorName, ColorName])[] = [
  ["ink", "blotter"], ["ink", "sheet"], ["inkSoft", "sheet"], ["inkSoft", "blotter"], ["action", "sheet"], ["action", "blotter"],
  ["sheet", "action"], ["stamp", "sheet"], ["overdueFg", "overdueBg"], ["okFg", "okBg"], ["soonFg", "soonBg"], ["neutralFg", "neutralBg"],
];

/** Field borders and focus rings: WCAG AA needs 3 to 1. */
export const UI_PAIRS: readonly (readonly [ColorName, ColorName])[] = [["field", "sheet"], ["action", "sheet"], ["action", "blotter"]];
