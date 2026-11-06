"use client";

import { useCallback, useRef, useState } from "react";

/** Runs one user-started action at a time and keeps its latest outcome. A new run clears the previous outcome first. */
export function useAction<T>(describe: (e: unknown) => string) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  const run = useCallback(
    async (work: () => Promise<T>): Promise<T | undefined> => {
      if (running.current) return undefined;
      running.current = true;
      setBusy(true);
      setResult(null);
      setError(null);
      try {
        const out = await work();
        setResult(out);
        return out;
      } catch (e) {
        setError(describe(e));
        return undefined;
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [describe],
  );
  const fail = useCallback((message: string) => {
    setResult(null);
    setError(message);
  }, []);
  return { busy, result, error, run, fail };
}
