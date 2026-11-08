import type { Metadata } from "next";
import { VerifyReceipt } from "@/components/VerifyReceipt";
import { API_BASE_URL } from "@/lib/config";

export const metadata: Metadata = {
  title: "Check a consent receipt | Saral Privacy",
  description: "Paste a consent receipt to check that it was signed by Saral's published key and has not been changed. Nothing you paste leaves your browser.",
};

export default function VerifyPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">Check a consent receipt</h1>
        <p className="mt-3 text-lg leading-relaxed text-ink-soft">
          When you agree to something through a Saral consent banner, you get a signed receipt. Paste it here to check that it was
          signed with the key Saral publishes, and that nobody has changed it since. The check runs in your browser and nothing you
          paste is sent anywhere. It is still part of this site, though, and someone who ran this site could change it. A check that
          does not depend on this site needs a tool of your own and the public key from a source you trust. The method is public and short.
        </p>
      </header>
      <VerifyReceipt apiBase={API_BASE_URL} />
    </main>
  );
}
