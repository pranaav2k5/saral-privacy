import { postJson } from "./api";
import { STRINGS, type Locale, type Strings } from "./i18n";
import { Store, type ConsentState } from "./store";
import { CSS } from "./styles";

export type { Locale } from "./i18n";
export type { ConsentState } from "./store";

export interface PurposeConfig {
  key: string;
  label: string;
  description?: string;
}

export interface InitOptions {
  /** A publishable key (`pk_...`). Never put a secret key in a web page. */
  publishableKey: string;
  /** Base URL of the Saral API, https (http only for localhost). */
  apiBase: string;
  noticeId: string;
  purposes: PurposeConfig[];
  locale?: Locale;
  /** The person's email or phone number, if the page already knows it. If absent, the dialog asks. */
  identifier?: string | (() => string | undefined | Promise<string | undefined>);
  container?: HTMLElement;
  onChange?: (state: ConsentState | null) => void;
  /** Open the dialog at start if the person has not decided yet. Default true. */
  openOnInit?: boolean;
  /** Test seams. */
  fetch?: typeof fetch;
  storage?: Storage;
}

export interface SaralPrivacyInstance {
  open(): void;
  close(): void;
  getConsent(): ConsentState | null;
  withdraw(): Promise<void>;
  destroy(): void;
}

const KEY_RE = /^pk_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PURPOSE_KEY_RE = /^[a-z][a-z0-9_]{0,62}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+[0-9]{8,15}$/;
const MAX_PURPOSES = 50;

const isIdentifier = (v: string): boolean => EMAIL_RE.test(v.trim()) || PHONE_RE.test(v.replace(/[\s-]/g, ""));

function validate(o: InitOptions): { apiBase: string; locale: Locale } {
  if (typeof o.publishableKey !== "string" || o.publishableKey.startsWith("sk_")) throw new Error("publishableKey must be a publishable key (pk_...). Never use a secret key in a browser.");
  if (!KEY_RE.test(o.publishableKey)) throw new Error("publishableKey is not a valid publishable key");
  if (typeof o.noticeId !== "string" || !UUID_RE.test(o.noticeId)) throw new Error("noticeId must be a notice id (a lowercase UUID)");
  let url: URL;
  try {
    url = new URL(o.apiBase);
  } catch {
    throw new Error("apiBase must be a URL");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("apiBase must use https (http is allowed for localhost only)");
  if (!Array.isArray(o.purposes) || o.purposes.length < 1 || o.purposes.length > MAX_PURPOSES) throw new Error(`purposes must list 1 to ${String(MAX_PURPOSES)} purposes`);
  const seen = new Set<string>();
  for (const p of o.purposes) {
    if (typeof p?.key !== "string" || !PURPOSE_KEY_RE.test(p.key)) throw new Error("each purpose key must be lowercase letters, digits and underscores, starting with a letter");
    if (seen.has(p.key)) throw new Error(`purpose key ${p.key} is used twice`);
    seen.add(p.key);
    if (typeof p.label !== "string" || p.label.trim() === "" || p.label.length > 200) throw new Error("each purpose needs a label of 1 to 200 characters");
  }
  const locale = o.locale ?? "en";
  if (locale !== "en" && locale !== "hi") throw new Error("locale must be en or hi");
  return { apiBase: o.apiBase.replace(/\/+$/, ""), locale };
}

type Props = Record<string, string | boolean | undefined>;

/** Builds an element with text only: no markup is ever parsed from a string. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (k === "className") node.className = String(v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) node.append(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

const instances = new WeakMap<HTMLElement, SaralPrivacyInstance>();
let styleUsers = 0;
let uid = 0;

export function init(options: InitOptions): SaralPrivacyInstance {
  const { apiBase, locale } = validate(options);
  const container = options.container ?? document.body;
  instances.get(container)?.destroy();

  const t: Strings = STRINGS[locale];
  const store = new Store(options.noticeId, options.storage ?? safeLocalStorage());
  const doFetch = (...args: Parameters<typeof fetch>) => (options.fetch ?? globalThis.fetch.bind(globalThis))(...args);
  const id = `sp-${String(++uid)}`;

  let view: "closed" | "banner" | "manage" = "closed";
  let pending = false;
  let error = "";
  let identifierValue = "";
  let invalidIdentifier = false;
  let previousFocus: Element | null = null;
  let status = "";
  const choices = new Map<string, boolean>(options.purposes.map((p) => [p.key, false]));

  if (styleUsers++ === 0) document.head.append(el("style", { "data-saral-privacy": "" }, CSS));
  const root = el("div", { className: "sp-root", lang: locale });
  const statusEl = el("div", { className: "sp-status", role: "status" });
  root.append(statusEl);
  container.append(root);

  const notify = (s: ConsentState | null) => options.onChange?.(s);
  const knownIdentifier = options.identifier !== undefined;

  async function resolveIdentifier(): Promise<string | undefined> {
    const given = typeof options.identifier === "function" ? await options.identifier() : (options.identifier ?? identifierValue);
    return given?.trim() ? given.trim() : undefined;
  }

  function fail(message: string, bad = false): void {
    error = message;
    invalidIdentifier = bad;
    pending = false;
    render();
  }

  async function grant(mode: "selected" | "all"): Promise<void> {
    if (pending) return;
    pending = true; // before the first await, so a second click in the same instant cannot start a second request
    if (mode === "all") for (const k of choices.keys()) choices.set(k, true);
    if (![...choices.values()].some(Boolean)) return fail(t.errNothing);
    const identifier = await resolveIdentifier();
    if (identifier === undefined || !isIdentifier(identifier)) return fail(t.errIdentifier, !knownIdentifier);
    error = "";
    invalidIdentifier = false;
    render();
    const purposes = options.purposes.map((p) => ({ key: p.key, granted: choices.get(p.key) === true }));
    const out = await postJson(doFetch, `${apiBase}/v1/consents`, options.publishableKey, { noticeId: options.noticeId, identifier, purposes });
    if (out.kind === "network") return fail(t.errNetwork);
    if (out.kind === "http") return fail(out.status === 401 || out.status === 403 ? t.errAuth : t.errSave);
    const body = out.body as { consentId?: unknown; receiptId?: unknown };
    if (typeof body.consentId !== "string" || typeof body.receiptId !== "string") return fail(t.errSave);
    const state: ConsentState = {
      decision: "granted",
      consentId: body.consentId,
      receiptId: body.receiptId,
      purposes: Object.fromEntries(purposes.map((p) => [p.key, p.granted])),
      at: new Date().toISOString(),
    };
    store.write(state);
    pending = false;
    status = t.savedNote;
    close();
    notify(state);
  }

  function reject(): void {
    if (pending) return;
    const state: ConsentState = { decision: "refused", purposes: Object.fromEntries(options.purposes.map((p) => [p.key, false])), at: new Date().toISOString() };
    store.write(state);
    status = t.refusedNote;
    close();
    notify(state);
  }

  async function withdraw(): Promise<void> {
    const current = store.read();
    if (pending || current?.decision !== "granted" || current.consentId === undefined) return;
    pending = true;
    const identifier = await resolveIdentifier();
    if (identifier === undefined || !isIdentifier(identifier)) return fail(t.errIdentifier, !knownIdentifier);
    error = "";
    invalidIdentifier = false;
    render();
    const out = await postJson(doFetch, `${apiBase}/v1/consents/${encodeURIComponent(current.consentId)}/withdraw`, options.publishableKey, { identifier });
    if (out.kind === "network") return fail(t.errNetwork);
    // 409 means it was already withdrawn: the person's wish is met either way.
    if (out.kind === "http" && out.status !== 409) return fail(out.status === 401 || out.status === 403 ? t.errAuth : t.errWithdraw);
    store.clear();
    for (const k of choices.keys()) choices.set(k, false);
    pending = false;
    status = t.withdrawnNote;
    close();
    notify(null);
  }

  function open(): void {
    if (view !== "closed") return;
    previousFocus = document.activeElement;
    const current = store.read();
    view = current?.decision === "granted" ? "manage" : "banner";
    error = "";
    status = "";
    render();
    document.addEventListener("keydown", onKey);
    const first = root.querySelector<HTMLElement>(view === "banner" ? 'input[role="switch"]' : "button, input");
    first?.focus();
  }

  function close(): void {
    document.removeEventListener("keydown", onKey);
    view = "closed";
    render();
    const back = previousFocus;
    previousFocus = null;
    if (back instanceof HTMLElement && back.isConnected) back.focus();
  }

  function onKey(e: KeyboardEvent): void {
    const dialog = root.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])")];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) return;
    const inside = dialog.contains(document.activeElement);
    if (e.shiftKey && (!inside || document.activeElement === first)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
      e.preventDefault();
      first.focus();
    }
  }

  function identifierField(): HTMLElement | null {
    if (knownIdentifier) return null;
    const input = el("input", { id: `${id}-id`, name: "identifier", type: "text", autocomplete: "email", "aria-describedby": `${id}-hint`, "aria-invalid": invalidIdentifier ? "true" : undefined });
    input.value = identifierValue;
    input.addEventListener("input", () => (identifierValue = input.value));
    return el("div", { className: "sp-field" }, el("label", { for: `${id}-id` }, t.identifierLabel), input, el("p", { id: `${id}-hint`, className: "sp-hint" }, t.identifierHint));
  }

  function button(text: string, onClick: () => void): HTMLButtonElement {
    const b = el("button", { type: "button", className: "sp-btn", disabled: pending }, text);
    b.addEventListener("click", onClick);
    return b;
  }

  function render(): void {
    root.querySelector(".sp-backdrop")?.remove();
    root.querySelector(".sp-opener")?.remove();
    statusEl.textContent = status;
    if (view === "closed") {
      const opener = el("button", { type: "button", className: "sp-opener" }, t.opener);
      opener.addEventListener("click", open);
      root.append(opener);
      return;
    }
    const current = store.read();
    const manage = view === "manage";
    const list = el("ul", { className: "sp-purposes" });
    for (const p of options.purposes) {
      const text = el("span", { className: "sp-label" }, p.label);
      const desc = p.description ? el("span", { className: "sp-desc" }, p.description) : null;
      let row: HTMLElement;
      if (manage) {
        row = el("div", { className: "sp-row" }, el("span", { className: "sp-state" }, current?.purposes[p.key] ? t.on : t.off), text);
        if (desc) row.append(desc);
      } else {
        const box = el("input", { type: "checkbox", role: "switch", "data-purpose": p.key });
        box.checked = choices.get(p.key) === true;
        box.disabled = pending;
        box.addEventListener("change", () => choices.set(p.key, box.checked));
        row = el("label", { className: "sp-row" }, box, text);
        if (desc) row.append(desc);
      }
      list.append(el("li", {}, row));
    }
    const actions = el("div", { className: "sp-actions" });
    if (manage) {
      actions.append(button(t.withdraw, () => void withdraw()), button(t.close, close));
    } else {
      // All three buttons are the same element with the same classes: rejecting is exactly as easy as accepting.
      actions.append(button(t.rejectAll, reject), button(t.acceptSelected, () => void grant("selected")), button(t.acceptAll, () => void grant("all")));
    }
    const title = el("h2", { id: `${id}-title` }, manage ? t.manageTitle : t.title);
    const dialog = el(
      "div",
      { className: "sp-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": `${id}-title`, "aria-describedby": `${id}-desc`, "aria-busy": pending ? "true" : undefined },
      title,
      el("p", { id: `${id}-desc` }, t.intro),
      list,
    );
    const field = identifierField();
    if (field) dialog.append(field);
    dialog.append(el("p", { className: "sp-alert", role: "alert" }, error), actions);
    root.append(el("div", { className: "sp-backdrop" }, dialog));
    if (pending) return;
    const target = invalidIdentifier ? root.querySelector<HTMLElement>('input[name="identifier"]') : null;
    target?.focus();
  }

  const instance: SaralPrivacyInstance = {
    open,
    close: () => {
      if (view !== "closed") close();
    },
    getConsent: () => store.read(),
    withdraw,
    destroy() {
      document.removeEventListener("keydown", onKey);
      root.remove();
      instances.delete(container);
      if (--styleUsers === 0) document.head.querySelector("style[data-saral-privacy]")?.remove();
    },
  };
  instances.set(container, instance);
  render();
  if ((options.openOnInit ?? true) && store.read() === null) open();
  return instance;
}

function safeLocalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
