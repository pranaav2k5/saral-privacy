import { SECURITY_HEADERS } from "./security-headers";

const header = (name: string) => SECURITY_HEADERS.find((h) => h.key.toLowerCase() === name.toLowerCase())?.value;

describe("headers sent with every dashboard page", () => {
  test("the dashboard cannot be framed by another site (clickjacking), by either the modern or the old header", () => {
    expect(header("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(header("X-Frame-Options")).toBe("DENY");
  });

  test("forms can only post to the dashboard itself, and plugins and a changed base address are not allowed", () => {
    const csp = header("Content-Security-Policy") ?? "";
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  test("the browser does not guess content types and does not send the page address to other sites", () => {
    expect(header("X-Content-Type-Options")).toBe("nosniff");
    expect(header("Referrer-Policy")).toBe("no-referrer");
  });

  test("camera, microphone and location are switched off", () => {
    expect(header("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
  });
});
