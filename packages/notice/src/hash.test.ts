import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalNoticeText, noticeSha256 } from "./hash";

describe("canonicalNoticeText", () => {
  test("normalises line endings, trailing spaces and the final newline", () => {
    expect(canonicalNoticeText("café \r\nline two  \r\n\r\n\r\n")).toBe("café\nline two\n");
    expect(canonicalNoticeText("a\rb")).toBe("a\nb\n");
    expect(canonicalNoticeText("a\tb \t\n")).toBe("a\tb\n");
  });

  test("normalises Unicode to NFC", () => {
    expect(canonicalNoticeText("café")).toBe("café\n");
  });

  test("is idempotent", () => {
    const once = canonicalNoticeText("x \r\ny\r\n\r\n");
    expect(canonicalNoticeText(once)).toBe(once);
  });

  test("keeps interior blank lines", () => {
    expect(canonicalNoticeText("a\n\nb\n")).toBe("a\n\nb\n");
  });
});

describe("noticeSha256", () => {
  test("known answers computed with sha256sum", async () => {
    expect(await noticeSha256("café \r\nline two  \r\n\r\n\r\n")).toBe(
      "6881291064790d0c571da85e67a17c04954834b8c26ebafac7632d0dbab8db9f",
    );
    const golden = readFileSync(join(__dirname, "golden", "notice-en.txt"), "utf8");
    expect(await noticeSha256(golden)).toBe("0928cd3c111a128d6893853397e47b39ac6839743d19c985dc20f393ea07fc4b");
  });

  test("CRLF, trailing spaces and NFD give the same hash as the canonical form", async () => {
    const base = "Line one\nLine café\n";
    const variant = "Line one  \r\nLine café\r\n\r\n";
    expect(await noticeSha256(variant)).toBe(await noticeSha256(base));
  });

  test("one changed character changes the hash", async () => {
    expect(await noticeSha256("retention: 12 months\n")).not.toBe(await noticeSha256("retention: 13 months\n"));
  });
});
