import type { ReactNode } from "react";
import type { RenderedNotice } from "@saral/notice";

export type CopyState = "idle" | "copied" | "failed";

interface Props {
  notice: RenderedNotice | null;
  fingerprint: string | null;
  copyState: CopyState;
  onCopy: () => void;
}

const STAMP: Record<RenderedNotice["language"], string> = { en: "DRAFT", hi: "मसौदा" };
const MARKDOWN_PREFIX = "data:text/markdown;charset=utf-8,";

const actionClass =
  "rounded-md border border-action px-4 py-2 text-sm font-medium text-action hover:bg-blotter";

/**
 * Shows a section's lines as paragraphs and lists instead of pre-formatted text, so a wrapped line keeps its
 * indent. The text that is copied and hashed is still the canonical Markdown from the engine.
 */
function NoticeBody({ lines }: { lines: string[] }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flushBullets = (at: number) => {
    if (bullets.length === 0) return;
    blocks.push(
      <ul key={`ul-${String(at)}`} className="mt-2 list-disc space-y-1 pl-6">
        {bullets.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };
  lines.forEach((line, i) => {
    if (line.startsWith("- ")) {
      bullets.push(line.slice(2));
      return;
    }
    flushBullets(i);
    if (line.trim() === "") return;
    const key = `p-${String(i)}`;
    if (/^\d+\. /.test(line)) {
      blocks.push(
        <p key={key} className="mt-4 font-semibold">
          {line}
        </p>,
      );
    } else if (line.startsWith("   ")) {
      blocks.push(
        <p key={key} className="pl-6">
          {line.trim()}
        </p>,
      );
    } else {
      blocks.push(
        <p key={key} className="mt-2 first:mt-0">
          {line}
        </p>,
      );
    }
  });
  flushBullets(lines.length);
  return <div className="mt-2">{blocks}</div>;
}

export default function NoticeSheet({ notice, fingerprint, copyState, onCopy }: Props) {
  if (notice === null) {
    return (
      <section
        aria-label="Notice preview"
        className="rounded-sm border border-dashed border-field bg-sheet/60 p-8 text-ink-soft"
      >
        <p className="max-w-sm leading-relaxed">
          Your notice appears here after you press Create notice.
        </p>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <article
        lang={notice.language}
        aria-labelledby="notice-title"
        className="relative rounded-sm border border-rule bg-sheet px-5 py-8 font-sheet sm:px-8 sm:py-9 text-[1.0625rem] leading-[1.7] shadow-[0_1px_0_var(--color-rule),0_12px_32px_-18px_rgba(27,42,65,0.35)]"
      >
        <span
          aria-hidden="true"
          className="notice-stamp mb-4 inline-block rounded-sm border-[3px] border-stamp px-3 py-1 font-ui text-lg font-bold tracking-widest text-stamp sm:absolute sm:right-6 sm:top-6 sm:mb-0"
        >
          {STAMP[notice.language]}
        </span>
        <h2 id="notice-title" className="max-w-[24rem] text-2xl font-semibold leading-snug">
          {notice.title}
        </h2>
        <p className="mt-4 max-w-[36rem] border-l-[3px] border-stamp pl-4 text-[0.95rem] leading-relaxed text-ink-soft">
          {notice.banner}
        </p>
        {notice.sections.map((s) => (
          <section key={s.heading} className="mt-7 max-w-[36rem]">
            <h3 className="text-lg font-semibold">{s.heading}</h3>
            <NoticeBody lines={s.body} />
          </section>
        ))}
      </article>

      <div className="flex flex-wrap items-center gap-3 font-ui">
        <button type="button" className={actionClass} onClick={onCopy}>
          Copy text
        </button>
        <a
          className={actionClass}
          download={`privacy-notice-${notice.language}.md`}
          href={`${MARKDOWN_PREFIX}${encodeURIComponent(notice.text)}`}
        >
          Download as Markdown
        </a>
        <span role="status" className="text-sm text-ink-soft">
          {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed. Select the text and copy it yourself." : ""}
        </span>
      </div>

      <div className="font-ui text-sm text-ink-soft">
        <p className="font-medium text-ink">Fingerprint (SHA-256)</p>
        <p className="mt-1 break-all font-mono">{fingerprint ?? "Calculating"}</p>
        <p className="mt-2 max-w-[36rem] leading-relaxed">
          Keep this with the date you publish the notice. If the wording changes, so does the fingerprint, and
          that lets you show later which text you published.
        </p>
      </div>
    </div>
  );
}
