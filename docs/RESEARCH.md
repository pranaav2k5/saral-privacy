# Research Log

Written 2026-11-05. This file records what was checked against outside sources while building `PLAN.md`, what was found wrong or inconsistent in the two input documents, and what is still unverified.

Method: web searches and AWS documentation lookups on 2026-11-05. Most DPDP sources are law-firm and compliance-vendor blogs, not the Gazette. Treat them as secondary. Before anything here is used in a customer contract, investor deck, or filing, check the primary text (the Gazette of India, the MeitY site, the Data Protection Board site).

Input documents:

- **Strategy Report**: `Saral_Privacy_Strategy_Report.pdf` (36 pages, May 2026).
- **Feasibility Study**: `Saral Privacy DPDP Compliance Platform_ Technical Feasibility an.md` (May 2026). Its inline citation links are noisy: several are attached to the wrong claim, so do not rely on them as sources.

---

## 1. Verified or partly verified

| Claim | Finding | Source |
|---|---|---|
| Consent Manager registration opens 13 Nov 2026 | Consistent across several law-firm and vendor sources. Registration process to be set by Board notification. | [Maheshwari & Co](https://www.maheshwariandco.com/blog/dpdp-consent-manager-framework-november-2026/), [Ampcus Cyber](https://www.ampcuscyber.com/blogs/dpdp-consent-managers-go-live-in-november-what-data-fiduciaries-should-do-now/), [Tsaaro](https://tsaaro.com/blogs/consent-manager-registration-opens-soon-technical-and-legal-readiness-checklist-for-aspiring-consent-managers) |
| DPB interoperability standard for Consent Managers not yet published | No published standard found. Guides tell applicants to confirm interoperability details once the Board and MeitY publish them. | Same sources as above |
| Full compliance deadline is 13 May 2027 | Still the legal date. MeitY floated cutting 18 months to 12 months (Jan 2026, feedback due 4 Feb 2026), reportedly mainly for Significant Data Fiduciaries. Trackers report no notification as of Oct 2026. I did not find anything after October. | [Business Standard](https://www.business-standard.com/technology/tech-news/meity-may-cut-compliance-timeline-for-key-dpdp-rules-to-12-months-126012201293_1.html), [Legal500](https://www.legal500.com/intelligence/india/privacy/meity-plans-to-cut-short-dpdp-compliance-timeline-and-notify-cross-border-restrictions-for-sdfs), [dpdprules.org](https://dpdprules.org/blog/dpdp-18-months-to-12-months-proposal), [CADP](https://cadp.in/news/meity-cut-dpdp-compliance-window-12-months-sdf/) |
| Redacto raised about ₹12 crore seed from PeerCapital and Antler India | Confirmed by several outlets. Founded 2025. Works with payment companies and NBFCs. Not to be confused with Reducto, a US document-parsing startup. | [CIOL](https://www.ciol.com/funding-acquistion-merger/redacto-raises-12-crore-to-build-indias-privacy-infrastructure-10607084), [Indian Startup News](https://indianstartupnews.com/funding/ai-driven-privacy-infrastructure-startup-redacto-raiss-rs-12-crore-to-expand-product-engineering-teams-10607133) |
| IDfy's Privy won MeitY and NeGD "Code for Consent" challenge | Confirmed, but the date differs from the Strategy Report (see section 2). Jio Platforms was runner-up. The 50+ deployments and about 500 million users figures are company claims. | [Biometric Update](https://www.biometricupdate.com/202607/idfy-wins-privacy-challenge-as-india-operationalizes-dpdp-act), [IDTechWire](https://idtechwire.com/idfy-wins-indias-government-backed-dpdp-consent-challenge/), [VARindia](https://varindia.com/news/idfy-wins-dpdp-innovation-challenge) |
| Six firms were shortlisted in 2025 (Jio, IDfy, Redacto, Zoop, Concur, Aurelion) | Matches the Feasibility Study's list, which names the same six. | [Storyboard18](https://storyboard18.com/digital/meity-selects-six-firms-including-jio-platforms-for-code-for-consent-challenge-77886.htm) |
| IndicTrans2 is a suitable open translation base | MIT licensed, covers the 22 scheduled languages, strong published results against open and commercial baselines from 2023. I found no independent head-to-head against newer models such as Sarvam-Translate. | [AI4Bharat IndicTrans2](https://github.com/AI4Bharat/IndicTrans2) |

## 2. Corrections to the input documents

1. **S3 Object Lock can be enabled on an existing bucket.** The Feasibility Study says it can only be enabled at bucket creation and "cannot be retrofitted". AWS documents `PutObjectLockConfiguration` for existing buckets. Versioning is required, and once enabled Object Lock cannot be disabled. Creating buckets with it on in Terraform is still good practice, but it is not a one-way door that must be right in week 3. Source: [AWS: Configuring S3 Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-configure.html). The real irreversible risk is the opposite: a Compliance-mode lock on test data cannot be shortened, so use Governance mode outside production (decision D11).
2. **Privy's win date.** The Strategy Report says Privy won in March 2026. Press coverage is dated July 2026. Use July 2026.
3. **The 18-month window may change.** Both documents treat 13 May 2027 as fixed. It is still the legal date, but a shortening was proposed. See section 1.
4. **SageMaker Serverless and the translation model.** The Feasibility Study lists "SageMaker Serverless" as a hosting option for the 1.1 billion parameter IndicTrans2 model. As far as I know, serverless inference on SageMaker is CPU-only. I did not re-verify this today. The plan avoids the question by translating templates offline (D10).

## 3. Inconsistencies between the two input documents

| Topic | Strategy Report | Feasibility Study | Resolution in PLAN.md |
|---|---|---|---|
| Consent Manager | Apply Q4 2026; Consent Manager fees as a Y3 revenue line | Do not register; B2B revenue from Data Fiduciaries conflicts with the Consent Manager rules | D2 (Feasibility Study wins) |
| Mobile SDK | React Native | Kotlin Multiplatform | D6 (defer, choose by partner stack) |
| Backend | FastAPI plus NestJS | NestJS, FastAPI for ML only | D4 |
| Hosting | Vercel for frontend, AWS Mumbai or MeitY-empanelled cloud | All AWS ap-south-1, Fargate | D5 |
| Starter pricing | ₹15,000/month | ₹25,000/month | D8 |
| Pro pricing | ₹50,000 to ₹2 lakh/month | ₹1 lakh/month | D8 |
| Free notice generator | Week 4, in front of 100 founders by week 6 | Weeks 9 to 10 | D7 (both tracks) |
| Vault API | Beta in week 15 | Not in MVP | D14 (post-GA) |
| First DPI work | Core moat, 12 to 18 months of backlog | Defer until 3 customers ask | D13 |
| Certifications | SOC 2 from year 2 | ISO 27001 by month 9, SOC 2 Type I by month 12 | D15 |
| Languages in MVP | Hindi and English, then 5 more by week 12 | Six by weeks 9 to 10, five more by week 13 | D9 |
| MVP infra budget | Under ₹15,000/month | Multi-AZ RDS, ElastiCache, Fargate, Vault, GPU | Section 5.2 warning. Not priced. |
| Website domain | `saralprivacy.com` (notice tool) | `saralprivacy.in` (app, wallet, notices) | Open decision O4 |

Internal inconsistencies in the Strategy Report:

- Year-1 customers: the SOM table says 30 SMB plus 5 mid-market (about ₹1.35 crore ARR). The Lean Canvas says "target 100 paying customers in year 1". The three-phase GTM says 3 paid customers in months 0 to 6. The plan uses the conservative set (D17).
- SAM arithmetic: "200,000 entities × average ₹2 to 25 lakh a year" would give roughly ₹4,000 to ₹50,000 crore, but the document states ₹6,000 to ₹15,000 crore. The stated range implies an average spend of about ₹3 to 7.5 lakh. Treat the SAM as directional.
- The Starter and Pro year-3 LTV, CAC, and payback figures are internally consistent when recomputed, but they rest on assumptions (margin, retention, CAC) with no data behind them.

## 4. Not verified

These claims appear in the input documents. I did not check them, so they carry the original documents' level of confidence.

- Market and valuation figures: OneTrust at about $10 billion in PE talks, Securiti.ai acquired by Veeam for $1.73 billion, TrustArc to Main Capital, Skyflow growth rate, Sahamati ₹50 crore raise, IAPP's 264 regulatory changes, global market of $3.72 billion growing to $21.17 billion.
- Account Aggregator statistics (28.9 crore consents, 16 AA licences), 25 crore DigiLocker users, 70 crore ABHA IDs.
- Consumer data prices from ITIF and the Truth on the Market study.
- Exact DPDP Rules text: First Schedule Part A and Part B item numbers, rule numbers for notice, breach, retention, children, and rights, and the penalty schedule. The Feasibility Study cites these, and the penalty caps and non-readability wording look consistent with other sources I saw, but I did not read the Gazette text.
- AWS cost of the proposed stack. The AWS Pricing API returned `UnrecognizedClientException` (invalid credentials), so no price figures are in the plan. Use the AWS Pricing Calculator in week 3.
- Whether any SMB-focused Indian competitor besides Redacto is active. The Strategy Report says the SMB segment is "essentially untouched". Validate in discovery interviews.
- The Strategy Report's statement that Consent Manager revenue "cannot derive from data sharing" and the Feasibility Study's reading of items 2, 6, 8 to 10. Both need legal confirmation before we make any Consent Manager decision.

## 5. Research to do next

1. Read the Gazette text of the Rules, first for Rules 3, 6, 7, 8, 10, 14 and the First Schedule, and update the traceability matrix with exact wording.
2. Check the DPB site and MeitY notices after 13 Nov 2026 for the Consent Manager process and any timeline amendment.
3. Benchmark IndicTrans2 against at least one alternative on English to Hindi, Tamil, Telugu, Bengali, and Marathi using FLORES-200 or IN22 and a set of privacy-notice sentences.
4. Build an AWS cost estimate for dev, staging, and prod.
5. Sign up for Privy, Redacto, OneTrust, and Perfios trials and record what they cover and how they price.
6. Run the 25 discovery interviews and write the one-page summary.
