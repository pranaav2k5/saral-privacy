"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "./api";

export const messageOf = (e: unknown): string => (e instanceof ApiError ? e.message : "Something went wrong. Try again.");

type Settled<T> = { status: "ready"; data: T } | { status: "error"; error: string };

/**
 * Loads data for a screen. `load` must be stable (wrap it in `useCallback`): when it changes the screen is "loading" again,
 * and an answer to an older `load` is dropped, so a slow reply to an earlier choice can never overwrite a newer one.
 * `refresh()` fetches again but keeps showing the current data until the new data arrives; `retry()` goes back to "loading".
 */
export function useLoad<T>(load: () => Promise<T>) {
  const [settled, setSettled] = useState<{ forLoad: () => Promise<T>; result: Settled<T> } | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    load().then(
      (data) => live && setSettled({ forLoad: load, result: { status: "ready", data } }),
      (e: unknown) => live && setSettled({ forLoad: load, result: { status: "error", error: messageOf(e) } }),
    );
    return () => {
      live = false;
    };
  }, [load, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const retry = useCallback(() => {
    setSettled(null);
    setNonce((n) => n + 1);
  }, []);
  const state: { status: "loading" } | Settled<T> = settled && settled.forLoad === load ? settled.result : { status: "loading" };
  return { ...state, refresh, retry };
}
