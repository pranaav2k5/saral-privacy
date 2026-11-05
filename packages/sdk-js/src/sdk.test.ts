/** @jest-environment jsdom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { init, type ConsentState, type InitOptions, type SaralPrivacyInstance } from "./index";

const NOTICE = "55555555-5555-4555-8555-555555555555";
const KEY = "pk_" + "0".repeat(32) + "_" + "a".repeat(43);
const PURPOSES = [
  { key: "analytics", label: "Analytics", description: "Understand how the app is used" },
  { key: "marketing", label: "Product updates", description: "Emails about new features" },
];
const GRANTED = { consentId: "c1", receiptId: "r1", receipt: "a.b.c", status: "granted" };

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function fakeFetch(reply: (call: Call) => Response | Promise<Response> = () => json(201, GRANTED)) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const call = { url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> };
    calls.push(call);
    return reply(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

// jsdom has no Response global, so the fake answers with the three members the SDK reads.
const json = (status: number, body: unknown): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

let instances: SaralPrivacyInstance[] = [];

function start(options: Partial<InitOptions> & { fetch?: typeof fetch } = {}) {
  const f = fakeFetch();
  const states: (ConsentState | null)[] = [];
  const sdk = init({
    publishableKey: KEY,
    apiBase: "https://api.example.org",
    noticeId: NOTICE,
    purposes: PURPOSES,
    fetch: f.fn,
    onChange: (s) => states.push(s),
    ...options,
  });
  instances.push(sdk);
  return { sdk, calls: f.calls, states };
}

const dialog = (): HTMLElement | null => document.querySelector('[role="dialog"]');
const toggle = (key: string): HTMLInputElement => document.querySelector(`input[role="switch"][data-purpose="${key}"]`) as HTMLInputElement;
const button = (text: string): HTMLButtonElement => [...document.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement;
const identifierInput = (): HTMLInputElement | null => document.querySelector('input[name="identifier"]');
const alertText = (): string => document.querySelector('[role="alert"]')?.textContent ?? "";
const type = (el: HTMLInputElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
  document.head.querySelectorAll("style[data-saral-privacy]").forEach((s) => s.remove());
});

afterEach(() => {
  instances.forEach((i) => i.destroy());
  instances = [];
});

describe("the banner", () => {
  test("opens on first visit with every purpose off, each with its label and description", () => {
    start();
    expect(dialog()).not.toBeNull();
    expect(toggle("analytics").checked).toBe(false);
    expect(toggle("marketing").checked).toBe(false);
    expect(dialog()?.textContent).toContain("Understand how the app is used");
    expect(dialog()?.getAttribute("aria-modal")).toBe("true");
    expect(dialog()?.getAttribute("aria-labelledby")).toBeTruthy();
  });

  test("Reject all is exactly as prominent as the accept buttons: same element, same classes, same size", () => {
    start();
    const classes = ["Reject all", "Accept selected", "Accept all"].map((t) => button(t).className);
    expect(new Set(classes).size).toBe(1);
    expect(button("Reject all").tagName).toBe("BUTTON");
  });

  test("markup in a label or description is shown as text and creates no elements", () => {
    start({ purposes: [{ key: "analytics", label: "<img src=x onerror=alert(1)>", description: "<b>bold</b>" }] });
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
    expect(dialog()?.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  test("shows Hindi text for locale hi", () => {
    start({ locale: "hi" });
    expect(dialog()?.textContent).toContain("आपकी गोपनीयता");
    expect(document.querySelector("[lang='hi']")).not.toBeNull();
  });

  test("Escape closes it without recording anything, and focus goes back where it was", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { sdk, calls } = start({ openOnInit: false });
    sdk.open();
    expect(document.activeElement).not.toBe(opener);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(calls).toHaveLength(0);
    expect(localStorage.length).toBe(0);
  });

  test("Tab stays inside the dialog (focus trap)", () => {
    start();
    const buttons = [...(dialog() as HTMLElement).querySelectorAll<HTMLElement>("button, input")];
    const last = buttons.at(-1) as HTMLElement;
    last.focus();
    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect((dialog() as HTMLElement).contains(document.activeElement)).toBe(true);
    const first = buttons[0] as HTMLElement;
    first.focus();
    const back = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(back);
    expect(back.defaultPrevented).toBe(true);
  });
});

describe("granting", () => {
  test("Accept selected sends only the switched-on purposes as granted, with the key and no cookies", async () => {
    const { calls, states } = start();
    type(identifierInput() as HTMLInputElement, "person@example.org");
    toggle("analytics").click();
    button("Accept selected").click();
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example.org/v1/consents");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.credentials).toBe("omit");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.body).toEqual({
      noticeId: NOTICE,
      identifier: "person@example.org",
      purposes: [{ key: "analytics", granted: true }, { key: "marketing", granted: false }],
    });
    expect(dialog()).toBeNull();
    expect(states.at(-1)).toMatchObject({ decision: "granted", consentId: "c1", receiptId: "r1", purposes: { analytics: true, marketing: false } });
  });

  test("Accept all grants every purpose", async () => {
    const { calls } = start();
    type(identifierInput() as HTMLInputElement, "+91 98765-43210");
    button("Accept all").click();
    await flush();
    expect(calls[0]?.body.purposes).toEqual([{ key: "analytics", granted: true }, { key: "marketing", granted: true }]);
    expect(calls[0]?.body.identifier).toBe("+91 98765-43210");
  });

  test("a second click while the request is in flight sends nothing more", async () => {
    let release: (r: Response) => void = () => undefined;
    const slow = fakeFetch(() => new Promise<Response>((r) => (release = r)));
    start({ fetch: slow.fn });
    type(identifierInput() as HTMLInputElement, "person@example.org");
    toggle("analytics").click();
    button("Accept selected").click();
    button("Accept selected").click();
    await flush();
    expect(slow.calls).toHaveLength(1);
    expect(button("Accept selected").disabled).toBe(true);
    release(json(201, GRANTED));
    await flush();
    expect(dialog()).toBeNull();
  });

  test("nothing selected is not sent: it asks the person to choose, or to reject", async () => {
    const { calls } = start();
    type(identifierInput() as HTMLInputElement, "person@example.org");
    button("Accept selected").click();
    await flush();
    expect(calls).toHaveLength(0);
    expect(alertText()).toMatch(/choose at least one/i);
    expect(dialog()).not.toBeNull();
  });

  test("a host page that already knows the person supplies the identifier, and the field is not shown", async () => {
    const { calls } = start({ identifier: async () => "known@example.org" });
    expect(identifierInput()).toBeNull();
    button("Accept all").click();
    await flush();
    expect(calls[0]?.body.identifier).toBe("known@example.org");
  });

  test.each(["", "  ", "not-an-id", "12345", "a@b"])("an invalid identifier %p is refused before any request", async (value) => {
    const { calls } = start();
    type(identifierInput() as HTMLInputElement, value);
    button("Accept all").click();
    await flush();
    expect(calls).toHaveLength(0);
    expect(alertText()).toMatch(/email address or phone number/i);
    expect(identifierInput()?.getAttribute("aria-invalid")).toBe("true");
  });

  test("a network failure leaves the state unchanged, says so, and lets the person try again", async () => {
    const { states, sdk } = start({ fetch: (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch });
    type(identifierInput() as HTMLInputElement, "person@example.org");
    button("Accept all").click();
    await flush();
    expect(alertText()).toMatch(/could not reach/i);
    expect(sdk.getConsent()).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(states).toHaveLength(0);
    expect(dialog()).not.toBeNull();
    expect(button("Accept all").disabled).toBe(false);
  });

  test("an error from the API is shown in plain words and nothing is stored", async () => {
    start({ fetch: fakeFetch(() => json(422, { error: "nothing_granted", message: "internal detail" })).fn });
    type(identifierInput() as HTMLInputElement, "person@example.org");
    button("Accept all").click();
    await flush();
    expect(alertText()).toMatch(/could not be saved/i);
    expect(alertText()).not.toContain("internal detail");
    expect(localStorage.length).toBe(0);
  });

  test("a 401 or 403 says the site is not set up correctly, not that the person did something wrong", async () => {
    start({ fetch: fakeFetch(() => json(403, { message: "origin" })).fn });
    type(identifierInput() as HTMLInputElement, "person@example.org");
    button("Accept all").click();
    await flush();
    expect(alertText()).toMatch(/not set up correctly/i);
  });
});

describe("a host page whose identifier callback fails", () => {
  const callbacks: [string, NonNullable<InitOptions["identifier"]>][] = [
    ["rejects", async () => { throw new Error("session expired"); }],
    ["throws", () => { throw new Error("not logged in"); }],
    ["returns something that is not a string", (() => 42) as unknown as () => string],
    ["returns nothing", () => undefined],
  ];

  test.each(callbacks)("when it %s, the dialog says so and stays usable instead of freezing", async (_n, identifier) => {
    const { calls } = start({ identifier });
    button("Accept all").click();
    await flush();
    expect(calls).toHaveLength(0);
    expect(alertText()).toMatch(/email address or phone number/i);
    expect(button("Accept all").disabled).toBe(false);
    expect(dialog()).not.toBeNull();
  });

  test("after the page fixes it, the next click works", async () => {
    let known: string | undefined = undefined;
    const { calls } = start({ identifier: () => known });
    button("Accept all").click();
    await flush();
    expect(calls).toHaveLength(0);
    known = "back@example.org";
    button("Accept all").click();
    await flush();
    expect(calls).toHaveLength(1);
    expect(dialog()).toBeNull();
  });

  test("withdrawing with a failing callback also says so, and can be retried", async () => {
    let known: string | undefined = "known@example.org";
    const f = fakeFetch((c) => (c.url.endsWith("/withdraw") ? json(200, { status: "withdrawn" }) : json(201, GRANTED)));
    const { sdk } = start({ fetch: f.fn, identifier: () => known });
    button("Accept all").click();
    await flush();
    known = undefined;
    (document.querySelector("button.sp-opener") as HTMLButtonElement).click();
    button("Withdraw consent").click();
    await flush();
    expect(alertText()).toMatch(/email address or phone number/i);
    expect(button("Withdraw consent").disabled).toBe(false);
    known = "known@example.org";
    button("Withdraw consent").click();
    await flush();
    expect(sdk.getConsent()).toBeNull();
  });
});

describe("retrying a request safely", () => {
  const header = (c: Call) => (c.init.headers as Record<string, string>)["Idempotency-Key"];

  test("each request carries a random Idempotency-Key", async () => {
    const { calls } = start({ identifier: "person@example.org" });
    button("Accept all").click();
    await flush();
    expect(header(calls[0] as Call)).toMatch(/^[0-9a-f]{32}$/);
  });

  test("retrying the same request after a network failure reuses the key, so the server can return the first result", async () => {
    let fail = true;
    const f = fakeFetch(() => (fail ? (undefined as never) : json(201, GRANTED)));
    const failing = (async (url: string, init: RequestInit) => {
      if (fail) {
        f.calls.push({ url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        throw new TypeError("Failed to fetch");
      }
      return f.fn(url, init);
    }) as unknown as typeof fetch;
    start({ fetch: failing, identifier: "person@example.org" });
    button("Accept all").click();
    await flush();
    fail = false;
    button("Accept all").click();
    await flush();
    expect(f.calls).toHaveLength(2);
    expect(header(f.calls[0] as Call)).toBeDefined();
    expect(header(f.calls[1] as Call)).toBe(header(f.calls[0] as Call));
  });

  test("a changed choice gets a new key, and so does a request after a success", async () => {
    const f = fakeFetch((c) => (c.url.endsWith("/withdraw") ? json(200, { status: "withdrawn" }) : json(201, GRANTED)));
    const failing = (async (url: string, init: RequestInit) => {
      const r = await f.fn(url, init);
      return (f.calls.length === 1 ? ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response) : r);
    }) as unknown as typeof fetch;
    const { sdk } = start({ fetch: failing, identifier: "person@example.org" });
    toggle("analytics").click();
    button("Accept selected").click();
    await flush(); // 500: not saved
    toggle("marketing").click(); // a different request now
    button("Accept selected").click();
    await flush();
    expect(header(f.calls[1] as Call)).not.toBe(header(f.calls[0] as Call));
    await sdk.withdraw();
    sdk.open();
    toggle("analytics").click();
    toggle("marketing").click(); // exactly the choices of the request that succeeded before
    button("Accept selected").click();
    await flush();
    expect(JSON.stringify(f.calls.at(-1)?.body)).toBe(JSON.stringify(f.calls[1]?.body));
    expect(header(f.calls.at(-1) as Call)).not.toBe(header(f.calls[1] as Call)); // a new request, so a new key
  });

  test("without a secure random source no key is sent, and the request still works", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    try {
      const { calls } = start({ identifier: "person@example.org" });
      button("Accept all").click();
      await flush();
      expect(header(calls[0] as Call)).toBeUndefined();
      expect(calls).toHaveLength(1);
    } finally {
      if (original) Object.defineProperty(globalThis, "crypto", original);
    }
  });
});

describe("rejecting", () => {
  test("Reject all sends nothing, closes, and is remembered so the banner does not come back", async () => {
    const { calls, sdk, states } = start();
    button("Reject all").click();
    await flush();
    expect(calls).toHaveLength(0);
    expect(dialog()).toBeNull();
    expect(states.at(-1)).toMatchObject({ decision: "refused", purposes: { analytics: false, marketing: false } });
    sdk.destroy();
    document.body.innerHTML = "";
    start();
    expect(dialog()).toBeNull();
  });
});

describe("what the browser keeps", () => {
  test("only the decision, ids and per-purpose choices: never the identifier", async () => {
    start();
    type(identifierInput() as HTMLInputElement, "secret.person@example.org");
    button("Accept all").click();
    await flush();
    expect(localStorage.length).toBe(1);
    const raw = localStorage.getItem(localStorage.key(0) as string) as string;
    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual(["at", "consentId", "decision", "purposes", "receiptId"]);
    expect(raw).not.toContain("secret.person");
    expect(raw).not.toContain("example.org");
    expect(JSON.stringify({ ...document.body.dataset })).not.toContain("secret.person");
  });

  test("a stored value that is corrupt or from elsewhere is ignored", () => {
    localStorage.setItem(`saral-privacy:${NOTICE}`, "{not json");
    start();
    expect(dialog()).not.toBeNull();
    document.body.innerHTML = "";
    localStorage.setItem(`saral-privacy:${NOTICE}`, JSON.stringify({ decision: "granted", consentId: 5 }));
    start();
    expect(dialog()).not.toBeNull();
  });

  test("works when storage is unavailable", async () => {
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } } as unknown as Storage;
    const { sdk } = start({ storage: throwing });
    type(identifierInput() as HTMLInputElement, "person@example.org");
    button("Accept all").click();
    await flush();
    expect(sdk.getConsent()?.decision).toBe("granted"); // held in memory for this page
  });
});

describe("withdrawing", () => {
  async function grantFirst(options: Partial<InitOptions> = {}) {
    const f = fakeFetch((c) => (c.url.endsWith("/withdraw") ? json(200, { consentId: "c1", status: "withdrawn", withdrawnAt: "2026-11-06T10:00:00.000Z" }) : json(201, GRANTED)));
    const made = start({ fetch: f.fn, ...options });
    const input = identifierInput();
    if (input) type(input, "person@example.org"); // absent when the host page supplies the identifier
    button("Accept all").click();
    await flush();
    return { ...made, calls: f.calls };
  }

  test("a persistent button reopens the choices, and withdrawing is one click, as easy as granting", async () => {
    const { calls, states } = await grantFirst();
    const opener = document.querySelector("button.sp-opener") as HTMLButtonElement;
    expect(opener).not.toBeNull();
    opener.click();
    expect(dialog()?.textContent).toContain("Analytics");
    type(identifierInput() as HTMLInputElement, "person@example.org");
    button("Withdraw consent").click();
    await flush();
    expect(calls.map((c) => c.url)).toEqual(["https://api.example.org/v1/consents", "https://api.example.org/v1/consents/c1/withdraw"]);
    // Consent id and identifier together: knowing someone's email address is not enough to withdraw their consent.
    expect(calls[1]?.body).toEqual({ identifier: "person@example.org" });
    expect(states.at(-1)).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(document.body.textContent).toContain("withdrawn");
  });

  test("if the host knows the person, withdrawing asks nothing", async () => {
    const { calls } = await grantFirst({ identifier: "known@example.org" });
    (document.querySelector("button.sp-opener") as HTMLButtonElement).click();
    expect(identifierInput()).toBeNull();
    button("Withdraw consent").click();
    await flush();
    expect(calls[1]?.body).toEqual({ identifier: "known@example.org" });
  });

  test("a failed withdrawal keeps the consent on record, says so, and can be retried", async () => {
    let fail = true;
    const f = fakeFetch((c) => (c.url.endsWith("/withdraw") ? (fail ? json(404, {}) : json(200, { status: "withdrawn" })) : json(201, GRANTED)));
    const { sdk, states } = start({ fetch: f.fn });
    type(identifierInput() as HTMLInputElement, "person@example.org");
    button("Accept all").click();
    await flush();
    (document.querySelector("button.sp-opener") as HTMLButtonElement).click();
    type(identifierInput() as HTMLInputElement, "wrong@example.org");
    button("Withdraw consent").click();
    await flush();
    expect(alertText()).toMatch(/could not be withdrawn/i);
    expect(sdk.getConsent()?.decision).toBe("granted");
    expect(states.at(-1)?.decision).toBe("granted");
    fail = false;
    button("Withdraw consent").click();
    await flush();
    expect(sdk.getConsent()).toBeNull();
  });

  test("a withdrawal the server says is already done (409) counts as done: the person's wish is met", async () => {
    const f = fakeFetch((c) => (c.url.endsWith("/withdraw") ? json(409, { error: "not_granted" }) : json(201, GRANTED)));
    const { sdk, states } = start({ fetch: f.fn, identifier: "known@example.org" });
    button("Accept all").click();
    await flush();
    await sdk.withdraw();
    expect(sdk.getConsent()).toBeNull();
    expect(states.at(-1)).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  test("without a stored consent id there is nothing to withdraw by id, so nothing is sent", async () => {
    const f = fakeFetch(() => json(200, {}));
    const { sdk } = start({ fetch: f.fn, identifier: "known@example.org", openOnInit: false });
    localStorage.setItem(`saral-privacy:${NOTICE}`, JSON.stringify({ decision: "refused", purposes: { analytics: false }, at: "2026-11-06T09:00:00.000Z" }));
    await sdk.withdraw();
    expect(f.calls).toHaveLength(0);
  });

  test("sdk.withdraw() does the same without the dialog, for pages that build their own UI", async () => {
    const { sdk, calls } = await grantFirst({ identifier: "known@example.org" });
    await sdk.withdraw();
    expect(calls.at(-1)?.url).toContain("/withdraw");
    expect(sdk.getConsent()).toBeNull();
  });
});

describe("init", () => {
  test.each([
    ["no key", { publishableKey: "" }],
    ["a secret key (never ship one in a browser)", { publishableKey: "sk_" + "0".repeat(32) + "_" + "a".repeat(43) }],
    ["a malformed key", { publishableKey: "pk_nope" }],
    ["no notice id", { noticeId: "" }],
    ["an http API base", { apiBase: "http://api.example.org" }],
    ["no purposes", { purposes: [] }],
    ["a duplicate purpose key", { purposes: [PURPOSES[0], PURPOSES[0]] }],
    ["a purpose key with capitals", { purposes: [{ key: "Analytics", label: "A" }] }],
    ["an empty label", { purposes: [{ key: "analytics", label: "" }] }],
    ["more than 50 purposes", { purposes: Array.from({ length: 51 }, (_, i) => ({ key: `p${String(i)}`, label: "x" })) }],
    ["an unknown locale", { locale: "fr" }],
  ])("rejects %s", (_n, override) => {
    expect(() => start(override as Partial<InitOptions>)).toThrow();
  });

  test("a secret key is refused with a message that says why", () => {
    expect(() => start({ publishableKey: "sk_" + "0".repeat(32) + "_" + "a".repeat(43) })).toThrow(/secret key/);
  });

  test("allows http only for localhost, for development", () => {
    expect(() => start({ apiBase: "http://localhost:4000" })).not.toThrow();
  });

  test("openOnInit false waits for open(), and destroy() removes everything it added", () => {
    const { sdk } = start({ openOnInit: false });
    expect(dialog()).toBeNull();
    sdk.open();
    expect(dialog()).not.toBeNull();
    sdk.destroy();
    expect(document.querySelector(".sp-root")).toBeNull();
    expect(document.querySelector("style[data-saral-privacy]")).toBeNull();
  });

  test("a second init for the same container replaces the first instead of stacking dialogs", () => {
    start();
    start();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });
});

describe("source", () => {
  test("never builds markup from strings", () => {
    const dir = join(__dirname);
    for (const file of ["index.ts", "ui.ts", "api.ts", "store.ts", "i18n.ts", "styles.ts"]) {
      let src: string;
      try {
        src = readFileSync(join(dir, file), "utf8");
      } catch {
        continue;
      }
      for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) {
        expect({ file, banned, found: src.includes(banned) }).toEqual({ file, banned, found: false });
      }
    }
  });
});
