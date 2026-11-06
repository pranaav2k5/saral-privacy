import type { Metadata } from "next";
import NoticeForm from "./notice-form";

export const metadata: Metadata = {
  title: "Free privacy notice generator | Saral Privacy",
  description:
    "Answer a few questions and get a draft privacy notice in English or Hindi. Nothing you type leaves your browser.",
};

export default function NoticeGeneratorPage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-10">
      <header className="mb-10 max-w-2xl">
        <h1 className="text-3xl font-semibold tracking-tight">Write your privacy notice</h1>
        <p className="mt-3 text-lg leading-relaxed text-ink-soft">
          Answer a few questions and get a draft notice in English or Hindi. Nothing you type leaves this
          page. Have a lawyer read the draft before you publish it.
        </p>
      </header>
      <NoticeForm />
    </main>
  );
}
