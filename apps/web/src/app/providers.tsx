"use client";

import type { ReactNode } from "react";
import { AppFrame } from "@/components/Shell";
import { API_BASE_URL } from "@/lib/config";
import { SessionProvider } from "@/lib/session";

/** The one client boundary: the session, the sign-in gate, and the navigation around every page. */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <SessionProvider baseUrl={API_BASE_URL}>
      <AppFrame>{children}</AppFrame>
    </SessionProvider>
  );
}
