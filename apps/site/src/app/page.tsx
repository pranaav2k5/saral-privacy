import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-6 px-5 py-16">
      <h1 className="text-4xl font-semibold tracking-tight">Saral Privacy</h1>
      <p className="max-w-xl text-lg text-ink-soft">
        Consent and privacy tools for Indian businesses that have to follow the Digital Personal Data
        Protection Act, in English and Hindi.
      </p>
      <p>
        <Link
          href="/notice-generator"
          className="inline-block rounded-md bg-action px-5 py-3 font-medium text-white"
        >
          Write a privacy notice
        </Link>
      </p>
    </main>
  );
}
