import { receiptPolicyUrl } from "./policy-url.js";

const NOTICE = "55555555-5555-4555-8555-555555555555";

describe("receiptPolicyUrl", () => {
  test("points to the immutable public notice when a public base URL is configured", () => {
    expect(receiptPolicyUrl("https://api.example.org", "https://tenant.example/privacy", NOTICE)).toBe(`https://api.example.org/v1/notices/${NOTICE}`);
    expect(receiptPolicyUrl("https://api.example.org///", undefined, NOTICE)).toBe(`https://api.example.org/v1/notices/${NOTICE}`);
  });

  test("falls back to the tenant's own page when there is no public base URL", () => {
    expect(receiptPolicyUrl(undefined, "https://tenant.example/privacy", NOTICE)).toBe("https://tenant.example/privacy");
  });

  test("ignores a base URL that is not https, because a receipt needs an https link", () => {
    expect(receiptPolicyUrl("http://localhost:4000", "https://tenant.example/privacy", NOTICE)).toBe("https://tenant.example/privacy");
    expect(receiptPolicyUrl("http://localhost:4000", undefined, NOTICE)).toBeUndefined();
  });

  test("is undefined when neither is available", () => {
    expect(receiptPolicyUrl(undefined, undefined, NOTICE)).toBeUndefined();
  });
});
