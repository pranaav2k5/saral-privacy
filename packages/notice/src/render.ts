import { canonicalNoticeText } from "./hash";
import type { NoticeInput } from "./input";
import { en } from "./templates/en";
import { hi } from "./templates/hi";
import type { NoticeStrings } from "./templates/types";

export type NoticeLanguage = "en" | "hi";

export interface NoticeSection {
  heading: string;
  body: string[];
}

export interface RenderedNotice {
  language: NoticeLanguage;
  /** Always pending until a human reviewer signs off a template (decisions D9 and D16). */
  reviewStatus: "pending-human-review";
  title: string;
  banner: string;
  sections: NoticeSection[];
  /** Markdown-compatible text in canonical form. This is what gets hashed. */
  text: string;
}

const TEMPLATES: Record<NoticeLanguage, NoticeStrings> = { en, hi };

/**
 * Fills the reviewed template for `language` with validated tenant values. Values are inserted as plain
 * strings, once, and are never interpreted as template syntax. Headings come only from the template.
 */
export function renderNotice(input: NoticeInput, language: NoticeLanguage): RenderedNotice {
  const t = TEMPLATES[language];
  const purposeBlocks = input.purposes.map((p, i) => t.purposeLines(i + 1, p));
  const purposeBody = purposeBlocks.flatMap((lines, i) => (i === 0 ? lines : ["", ...lines]));

  const sections: NoticeSection[] = [
    { heading: t.headings.who, body: t.who(input.organisationName, input.websiteUrl, input.dpoName) },
    { heading: t.headings.data, body: [t.dataIntro, "", ...purposeBody] },
    {
      heading: t.headings.sharing,
      body: [input.thirdParties.length > 0 ? t.sharing(input.thirdParties.join(", ")) : t.sharingNone],
    },
    {
      heading: t.headings.rights,
      body: [t.rightsIntro, ...t.rights.map((r) => `- ${r}`), t.rightsHow(input.rightsRequestUrl, input.grievanceEmail)],
    },
    { heading: t.headings.withdraw, body: [t.withdraw(input.withdrawalUrl)] },
    { heading: t.headings.children, body: [input.processesChildrenData ? t.childrenYes : t.childrenNo] },
    { heading: t.headings.complaint, body: [t.complaint(input.grievanceEmail, input.grievanceAddress)] },
    { heading: t.headings.about, body: [t.about] },
  ];

  const title = t.title(input.organisationName);
  const lines = [`# ${title}`, "", `> ${t.banner}`, ""];
  for (const s of sections) lines.push(`## ${s.heading}`, "", ...s.body, "");
  return {
    language,
    reviewStatus: "pending-human-review",
    title,
    banner: t.banner,
    sections,
    text: canonicalNoticeText(lines.join("\n")),
  };
}
