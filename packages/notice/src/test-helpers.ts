import type { NoticeInput } from "./input";

export const goodInput = (): NoticeInput => ({
  organisationName: "Example Controller Pvt Ltd",
  websiteUrl: "https://example.org",
  grievanceEmail: "privacy@example.org",
  grievanceAddress: "1 Example Road, Bengaluru 560001, India",
  dpoName: "A. Example",
  purposes: [
    {
      name: "Product updates",
      description: "Send you emails about new features of our app.",
      dataItems: ["Email address", "Name"],
      retention: "Until you withdraw consent, then 30 days",
    },
    {
      name: "Analytics",
      description: "Understand how the app is used so we can improve it.",
      dataItems: ["Device type", "Pages visited"],
      retention: "12 months",
    },
  ],
  thirdParties: ["Example Analytics Ltd"],
  processesChildrenData: false,
  withdrawalUrl: "https://example.org/privacy/withdraw",
  rightsRequestUrl: "https://example.org/privacy/requests",
});
