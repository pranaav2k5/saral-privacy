import type { NoticeStrings } from "./types";

export const en: NoticeStrings = {
  title: (org) => `Privacy notice: ${org}`,
  banner:
    "DRAFT: this notice was generated from a template that has not been reviewed by a lawyer. Have your own counsel check it before you publish it. It is not legal advice.",
  headings: {
    who: "Who we are",
    data: "What personal data we process and why",
    sharing: "Who we share it with",
    rights: "Your rights and how to use them",
    withdraw: "How to withdraw your consent",
    children: "Children's personal data",
    complaint: "How to complain",
    about: "About this draft",
  },
  who: (org, website, dpo) => [
    `${org} ("we") is the data fiduciary that decides why and how your personal data is processed. Our website is ${website}.`,
    ...(dpo !== undefined ? [`Data protection officer or grievance contact: ${dpo}.`] : []),
  ],
  dataIntro: "We ask for your consent to process the personal data listed below, for each purpose.",
  purposeLines: (i, p) => [
    `${String(i)}. ${p.name}`,
    `   What we do: ${p.description}`,
    `   Personal data: ${p.dataItems.join(", ")}`,
    `   How long we keep it: ${p.retention}`,
  ],
  sharingNone: "We do not share your personal data with other organisations, except where the law requires us to.",
  sharing: (list) => `We share your personal data with: ${list}.`,
  rightsIntro: "You have the right to:",
  rights: [
    "withdraw your consent at any time;",
    "get a summary of the personal data we process and of the other parties we have shared it with;",
    "ask us to correct, complete or update your personal data, or to erase it;",
    "have your grievance handled by us;",
    "nominate another person to exercise your rights if you die or cannot act yourself.",
  ],
  rightsHow: (url, email) => `To use these rights, go to ${url} or write to ${email}.`,
  withdraw: (url) =>
    `You can withdraw your consent at any time, as easily as you gave it, at ${url}. Withdrawing does not affect processing that took place before you withdrew.`,
  childrenNo: "We do not knowingly process personal data of children (people under 18).",
  childrenYes:
    "We may process personal data of children (people under 18). We ask for verifiable consent from a parent or lawful guardian before we do.",
  complaint: (email, address) =>
    `Contact us first: ${email}, or write to: ${address}. We will respond to your grievance. If you are not satisfied with our response, you can complain to the Data Protection Board of India.`,
  about:
    "This notice was created from a template. It does not guarantee legal compliance. The organisation named above is responsible for its content.",
};
