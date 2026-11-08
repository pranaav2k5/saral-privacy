"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import type { Role } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Button } from "./ui";
import { AccountPage } from "./AccountPage";
import { SignIn } from "./SignIn";

const ROLE_NAME: Record<Role, string> = { tenant_admin: "Administrator", dpo: "Data protection officer" };

/** What each role can use. The API enforces the same split; this only keeps people from pages that would fail. */
export const NAV: Record<Role, readonly { href: string; label: string }[]> = {
  dpo: [
    { href: "/", label: "Overview" },
    { href: "/requests", label: "Requests" },
    { href: "/consents", label: "Consents" },
    { href: "/breaches", label: "Breaches" },
    { href: "/ropa", label: "Records" },
    { href: "/audit", label: "Audit" },
    { href: "/account", label: "Account" },
  ],
  tenant_admin: [
    { href: "/", label: "Overview" },
    { href: "/notices", label: "Notices" },
    { href: "/breaches", label: "Breaches" },
    { href: "/ropa", label: "Records" },
    { href: "/audit", label: "Audit" },
    { href: "/integrations", label: "Integrations" },
    { href: "/account", label: "Account" },
  ],
};

export function AppFrame({ children }: { children: ReactNode }) {
  const { status, role, signOut, mustChangePassword } = useSession();
  const path = usePathname();
  if (status === "loading") return <p role="status" className="p-6">Loading…</p>;
  if (status === "signedOut" || !role) return <SignIn />;
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:p-3 print:hidden">Skip to content</a>
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-rule bg-sheet px-4 py-2 print:hidden">
        <span className="font-semibold">Saral Privacy</span>
        <nav aria-label="Main" className="flex flex-wrap gap-1">
          {(mustChangePassword ? [] : NAV[role]).map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={path === item.href ? "page" : undefined}
              className="min-h-11 content-center rounded px-3 text-action underline-offset-4 hover:underline aria-[current=page]:bg-neutral-bg aria-[current=page]:font-semibold aria-[current=page]:text-ink"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <span className="ml-auto text-sm text-ink-soft">{ROLE_NAME[role]}</span>
        <Button type="button" onClick={signOut} className="bg-sheet !text-action border border-action">Sign out</Button>
      </header>
      {/* Until the person has chosen their own password the server refuses everything else, so no other page is shown. */}
      <main id="main" className="mx-auto w-full max-w-5xl flex-1 p-4 md:p-6">{mustChangePassword ? <AccountPage /> : children}</main>
    </div>
  );
}

/** Shows its children only to the listed roles. */
export function RequireRole({ roles, children }: { roles: readonly Role[]; children: ReactNode }) {
  const { role } = useSession();
  if (!role || !roles.includes(role)) return <p>Your role does not have access to this page.</p>;
  return <>{children}</>;
}
