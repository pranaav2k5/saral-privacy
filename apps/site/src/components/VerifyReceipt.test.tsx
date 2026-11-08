import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { VerifyReceipt } from "./VerifyReceipt";
import { HEADER, JWKS, K, b64u, claims, keypair, sign } from "@/test/receipt-fixtures";

const BASE = "https://api.example.org";
const good = () => sign(K.privateKey, HEADER, claims());

interface Call { url: string; init: RequestInit | undefined }
function setup(reply: (() => { status?: number; body?: unknown; throws?: boolean; wait?: Promise<unknown> }) | undefined = () => ({ body: JWKS })) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = (reply ?? (() => ({ body: JWKS })))();
    if (r.wait) await r.wait;
    if (r.throws) throw new TypeError("Failed to fetch");
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  render(<VerifyReceipt apiBase={BASE} fetchFn={fetchFn} />);
  return { calls };
}
const paste = (v: string) => fireEvent.change(screen.getByLabelText("Consent receipt"), { target: { value: v } });
const check = () => fireEvent.click(screen.getByRole("button", { name: "Check this receipt" }));

describe("before anything is pasted", () => {
  test("says what it does, where the keys come from, and that nothing pasted leaves the page", () => {
    setup();
    expect(screen.getByLabelText("Consent receipt")).toBeTruthy();
    expect(screen.getByText(/Nothing you paste leaves this page/)).toBeTruthy();
    expect(screen.getByText(`${BASE}/.well-known/jwks.json`)).toBeTruthy();
  });

  test("an empty box is turned back, and nothing is fetched", () => {
    const { calls } = setup();
    check();
    expect(screen.getByRole("alert").textContent).toBe("Paste the receipt first.");
    expect(calls).toHaveLength(0);
  });
});

describe("a genuine receipt", () => {
  test("is confirmed, and what it records is shown in words", async () => {
    setup();
    paste(`  ${good()}\n`);
    check();
    const result = await screen.findByRole("region", { name: "The signature is valid" });
    expect(result.textContent).toContain("has not been changed");
    expect(result.textContent).toContain("key-1");
    expect(result.textContent).toContain("Example Controller Pvt Ltd");
    expect(result.textContent).toContain("5f1d3f5e-8c61-4b1e-9d0a-0f6c1d2b3a4c");
    expect(result.textContent).toContain("6 November 2026, 09:30 UTC");
    expect(result.textContent).toContain("Example app");
    expect(result.textContent).toContain("Understand how the app is used");
    expect(result.textContent).toContain("analytics");
    expect(result.textContent).toContain("device type");
    expect(result.textContent).toContain("How to withdraw: https://example.org/privacy#withdraw");
    expect(result.textContent).not.toMatch(/Kept:/);
    expect(result.textContent).toContain("Shared with Example Analytics Ltd");
    expect(result.textContent).toContain("Not shared");
    expect(result.textContent).toContain("a".repeat(64));
  });

  test("comes with what the check does not show, so it is not read as more than it is", async () => {
    setup();
    paste(good());
    check();
    const limits = await screen.findByRole("region", { name: "What this does not show" });
    expect(limits.textContent).toMatch(/Who the person is/);
    expect(limits.textContent).toMatch(/still in force|withdrawn/);
    expect(limits.textContent).toMatch(/fingerprint/);
  });

  test("fetches only the public keys, with no cookies and no receipt in the request", async () => {
    const { calls } = setup();
    paste(good());
    check();
    await screen.findByRole("region", { name: "The signature is valid" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/.well-known/jwks.json`);
    expect(calls[0]?.init?.credentials).toBe("omit");
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(String(calls[0]?.url)).not.toContain(good().slice(0, 20));
  });

  test("shows the policy address as text, never as a link, and shows markup in the receipt as plain text", async () => {
    setup();
    const hostile = claims({ policyUrl: "https://evil.example/login", piiControllers: [{ ...claims().piiControllers[0], piiController: "<img src=x onerror=alert(1)>" }] });
    paste(sign(K.privateKey, HEADER, hostile));
    check();
    const result = await screen.findByRole("region", { name: "The signature is valid" });
    expect(result.textContent).toContain("https://evil.example/login");
    expect(within(result).queryByRole("link")).toBeNull();
    expect(result.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(result.querySelector("img")).toBeNull();
  });
});

describe("a receipt that cannot be confirmed", () => {
  test("a changed receipt is refused in plain words, and nothing it says is shown", async () => {
    setup();
    const [h, , s] = good().split(".") as [string, string, string];
    paste(`${h}.${b64u(JSON.stringify(claims({ consentTimestamp: 1 })))}.${s}`);
    check();
    expect((await screen.findByRole("alert")).textContent).toMatch(/has been changed since it was signed, or it was not issued by this service/);
    expect(screen.queryByRole("region", { name: "The signature is valid" })).toBeNull();
    expect(screen.queryByText(/Example Controller/)).toBeNull();
  });

  test("a receipt signed by someone else's key is refused", async () => {
    setup();
    paste(sign(keypair(2048, "key-1").privateKey, HEADER, claims()));
    check();
    expect((await screen.findByRole("alert")).textContent).toMatch(/Do not rely on it/);
  });

  test("something that is not a receipt is refused in words", async () => {
    setup();
    paste("hello there");
    check();
    expect((await screen.findByRole("alert")).textContent).toMatch(/not a consent receipt/);
  });

  test("when the keys cannot be fetched it says so, and does not say the receipt is bad", async () => {
    for (const reply of [() => ({ status: 500, body: {} }), () => ({ throws: true }), () => ({ body: { nope: true } }), () => ({ body: null })]) {
      const view = render(<div />);
      view.unmount();
      document.body.innerHTML = "";
      setup(reply);
      paste(good());
      check();
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(/could not get the signing keys/);
      expect(alert.textContent).toContain(BASE);
      expect(alert.textContent).not.toMatch(/changed|Do not rely/);
    }
  });
});

describe("checking again", () => {
  test("a second check replaces the first result", async () => {
    setup();
    paste(good());
    check();
    await screen.findByRole("region", { name: "The signature is valid" });
    paste("not a receipt");
    check();
    expect((await screen.findByRole("alert")).textContent).toMatch(/not a consent receipt/);
    expect(screen.queryByRole("region", { name: "The signature is valid" })).toBeNull();
  });

  test("the button cannot be pressed again while a check is running", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { calls } = setup(() => ({ body: JWKS, wait: gate }));
    paste(good());
    check();
    const busy = await screen.findByRole("button", { name: "Checking…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(busy);
    release();
    await screen.findByRole("region", { name: "The signature is valid" });
    expect(calls).toHaveLength(1);
  });

  test("the receipt that was pasted is kept in the box, not cleared or sent anywhere", async () => {
    setup();
    paste(good());
    check();
    await screen.findByRole("region", { name: "The signature is valid" });
    await waitFor(() => expect((screen.getByLabelText("Consent receipt") as HTMLTextAreaElement).value).toBe(good()));
  });
});
