# Notice template review record

The notice engine (`packages/notice`) fills fixed templates with an organisation's details. This file records what a lawyer must check before any template is marked as reviewed, and what has been reviewed so far.

## Status

| Template | Language | Written by | Legal review | Native-speaker review | Published status |
|---|---|---|---|---|---|
| `packages/notice/src/templates/en.ts` | English | AI-drafted, not by a lawyer | pending | not applicable | draft |
| `packages/notice/src/templates/hi.ts` | Hindi | AI-drafted, not by a lawyer | pending | pending | draft, "Beta, pending human review" |

Every rendered notice carries `reviewStatus: "pending-human-review"` and a banner saying so, in both languages (decisions D9 and D16 in `docs/PLAN.md`). The code has no way to render a notice without it. When a reviewer signs a template off, record the reviewer, date and template hash here and change the status in code in the same pull request.

## What the template is meant to cover

These are the notice elements as cited in `docs/PLAN.md` section 7 and the Feasibility Study. They have not been verified against the Gazette text of the Rules. The lawyer must confirm each mapping and the wording.

| Element (as cited) | Where in the template |
|---|---|
| Notice is a standalone document, in clear plain language | The whole notice; no legal citations in the body |
| Itemised description of the personal data and the specified purpose | Section "What personal data we process and why": one entry per purpose with its data items |
| The goods, services or uses the processing enables | "What we do" line of each purpose |
| A link to the fiduciary's website or app, and how to withdraw consent as easily as it was given | "Who we are" (website) and "How to withdraw your consent" (link) |
| How the data principal exercises their rights | "Your rights and how to use them" (rights list and a request link) |
| How to complain to the Data Protection Board | "How to complain" (grievance contact first, then the Board) |
| English or an Eighth Schedule language | English and Hindi |
| Children's data | "Children's personal data", with a verifiable parental consent line when the organisation says it processes children's data |

## Points the lawyer must decide

1. Whether the list of rights matches the Act's rights as they apply to a notice (withdrawal, summary of data and sharing, correction and erasure, grievance, nomination).
2. Whether "Contact us first, then the Board" is the right order and wording.
3. Whether the sentence "Withdrawing does not affect processing that took place before you withdrew" is accurate as written.
4. Whether the children's wording (under 18, verifiable consent from a parent or lawful guardian) matches the Act and Rules.
5. Whether "data fiduciary" and the Hindi term "डेटा न्यासी" are the right terms for a reader, and whether the term should appear at all.
6. Whether free-text fields supplied by the organisation (purpose names and descriptions, retention text) need guidance to stay accurate and specific.
7. Retention: the template prints whatever retention text the organisation enters. Whether that is enough for the Rules' retention requirements is open.

## Hindi

The Hindi text is a draft written without a native-speaker review. Terminology, register and grammar all need a reviewer who writes legal Hindi. Free-text values entered by the organisation are not translated (decision D10 plans a separate, reviewed path for that).
