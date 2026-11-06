"use client";

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { ApiClient, ApiError, type Role, type SessionInfo } from "./api";

/**
 * The staff session lives in this tab's `sessionStorage`: it ends when the tab closes, is never sent to other tabs, and
 * is never written to `localStorage`. Recovery codes are not stored at all (the sign-in screen shows them once).
 */
export const STORAGE_KEY = "saral.session";
export const SESSION_ENDED = "Your session ended. Sign in again.";

/** A session token lives 15 minutes. Within the last two, the next call renews it first. Idle tabs simply expire. */
const REFRESH_WITHIN_MS = 2 * 60_000;
const ROLES: readonly Role[] = ["tenant_admin", "dpo"];

type Snap =
  | { status: "loading" }
  | { status: "signedOut"; notice?: string }
  | { status: "signedIn"; role: Role; token: string; expiresAt: string };

const LOADING: Snap = { status: "loading" };

function parse(raw: string | null, now: number, notice: string | undefined): Snap {
  const out: Snap = notice === undefined ? { status: "signedOut" } : { status: "signedOut", notice };
  if (raw === null) return out;
  try {
    const v = JSON.parse(raw) as Partial<{ token: unknown; expiresAt: unknown; role: unknown }>;
    if (typeof v.token !== "string" || v.token === "" || typeof v.expiresAt !== "string" || !ROLES.includes(v.role as Role)) return out;
    if (!(Date.parse(v.expiresAt) > now)) return out;
    return { status: "signedIn", role: v.role as Role, token: v.token, expiresAt: v.expiresAt };
  } catch {
    return out;
  }
}

function createStore(now: () => number) {
  const listeners = new Set<() => void>();
  let notice: string | undefined;
  let lastRaw: string | null | undefined;
  let lastNotice: string | undefined;
  let snap: Snap = LOADING;
  const read = (): string | null => {
    try {
      return sessionStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  };
  const emit = () => listeners.forEach((l) => l());
  return {
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    snapshot(): Snap {
      const raw = read();
      if (snap !== LOADING && raw === lastRaw && notice === lastNotice) return snap;
      lastRaw = raw;
      lastNotice = notice;
      snap = parse(raw, now(), notice);
      return snap;
    },
    server: (): Snap => LOADING,
    /** Stores a session, or ends it (with an optional reason to show on the sign-in screen). */
    set(next: { token: string; expiresAt: string; role: Role } | null, why?: string) {
      try {
        if (next) sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ token: next.token, expiresAt: next.expiresAt, role: next.role }));
        else sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        /* storage blocked: the session then lasts only until the page reloads */
      }
      notice = why;
      emit();
    },
    /** Removes a stored value that could not be used (garbled, expired, or an unknown role). */
    discardUnusable() {
      if (snap.status === "signedOut" && read() !== null) {
        try {
          sessionStorage.removeItem(STORAGE_KEY);
        } catch {
          /* nothing to remove */
        }
      }
    },
    notice: () => notice,
  };
}

export interface SessionValue {
  status: "loading" | "signedOut" | "signedIn";
  role?: Role;
  /** Why the person was signed out, when it was not their choice. */
  notice?: string;
  api: ApiClient;
  /** The current time in milliseconds. Screens use this, not `Date`, so tests can fix the clock. */
  now: () => number;
  signIn(info: SessionInfo): void;
  signOut(): void;
}

const Ctx = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession needs a SessionProvider above it");
  return v;
}

export function SessionProvider({
  baseUrl,
  fetchFn,
  now = () => Date.now(),
  children,
}: {
  baseUrl: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  children: ReactNode;
}) {
  const [store] = useState(() => createStore(now));
  const snap = useSyncExternalStore(store.subscribe, store.snapshot, store.server);

  useEffect(() => {
    store.discardUnusable();
  }, [store, snap]);

  // The client must not change when the token does, or every screen would reload its data on each refresh.
  const api = useMemo(() => {
    const current = () => {
      const s = store.snapshot();
      return s.status === "signedIn" ? s : null;
    };
    const send: typeof fetch = (...args) => (fetchFn ?? fetch)(...args);
    // Any 401 on a request that carried a session means the session is no longer good: end it everywhere in this tab.
    const guarded: typeof fetch = async (input, init) => {
      const res = await send(input, init);
      const sent = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (res.status === 401 && sent !== undefined) store.set(null, SESSION_ENDED);
      return res;
    };
    const raw = new ApiClient(baseUrl, () => current()?.token, guarded);
    let inflight: Promise<void> | null = null;
    const renew = (): Promise<void> => {
      inflight ??= raw
        .refresh()
        .then((s) => store.set({ token: s.token, expiresAt: s.expiresAt, role: s.role }))
        .catch(() => undefined) // a refusal already ended the session in `guarded`; a network error lets the call try with the old token
        .finally(() => {
          inflight = null;
        });
      return inflight;
    };
    const api = new ApiClient(
      baseUrl,
      async () => {
        const had = current();
        if (had && Date.parse(had.expiresAt) - now() <= REFRESH_WITHIN_MS) await renew();
        const s = current();
        if (had && !s) throw new ApiError(401, SESSION_ENDED);
        return s?.token;
      },
      guarded,
    );
    return api;
  }, [store, baseUrl, fetchFn, now]);

  const value = useMemo<SessionValue>(
    () => ({
      status: snap.status,
      ...(snap.status === "signedIn" ? { role: snap.role } : {}),
      ...(snap.status === "signedOut" && snap.notice !== undefined ? { notice: snap.notice } : {}),
      api,
      now,
      signIn: (info) => store.set({ token: info.token, expiresAt: info.expiresAt, role: info.role }),
      signOut: () => store.set(null),
    }),
    [store, snap, api, now],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
