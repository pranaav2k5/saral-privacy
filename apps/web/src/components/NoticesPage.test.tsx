import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { NoticesPage } from "./NoticesPage";
import { when } from "@/lib/format";
import { renderScreen, type Call, type Route } from "@/test/harness";

const N1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const N2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HASH = "ab".repeat(32);
const v2 = { id: N2, version: 2, language: "en", reviewStatus: "pending-human-review", canonicalSha256: HASH, publishedAt: "2026-11-05T08:00:00.000Z", purposeKeys: ["analytics", "marketing"] };
const v1 = { id: N1, version: 1, language: "hi", reviewStatus: "reviewed", canonicalSha256: HASH, publishedAt: "2026-10-01T08:00:00.000Z", purposeKeys: ["analytics"] };
const made = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", version: 3, language: "en", reviewStatus: "pending-human-review", canonicalSha256: HASH, publishedAt: "2026-11-06T10:00:00.000Z", purposeKeys: ["analytics"] };

const page = (routes: Record<string, Route | Route[]> = {}) => renderScreen(<NoticesPage />, { role: "tenant_admin", routes: { "GET /v1/notices": { body: [v2, v1] }, ...routes } });

const fill = (label: string, value: string, scope: HTMLElement | Document = document.body) =>
  fireEvent.change(within(scope as HTMLElement).getByLabelText(label), { target: { value } });
const purpose = (n: number) => screen.getByRole("group", { name: `Purpose ${String(n)}` });

function fillOrganisation() {
  fill("Organisation name", "Example Controller Pvt Ltd");
  fill("Website", "https://example.org");
  fill("Grievance email", "privacy@example.org");
  fill("Grievance address", "1 Example Road, Bengaluru 560001");
  fill("Withdrawal link", "https://example.org/privacy#withdraw");
  fill("Rights request link", "https://example.org/privacy#rights");
}
function fillPurpose(n: number, over: Record<string, string> = {}) {
  const g = purpose(n);
  const v = {
    Key: "analytics", Name: "Understand how the app is used", Description: "We count which screens are opened.", "Data items": "device type\nscreens opened",
    "How long, in words": "12 months", "How long, in days": "365", "Purpose categories": "analytics", "Data categories": "device type", ...over,
  };
  for (const [label, value] of Object.entries(v)) fill(label, value, g);
}
const publish = () => fireEvent.click(screen.getByRole("button", { name: "Publish notice" }));
const publishAgain = async () => fireEvent.click(await screen.findByRole("button", { name: "Publish notice" }));
const posted = (v: ReturnType<typeof page>) => v.callsTo("POST", "/v1/notices");

describe("the list", () => {
  test("shows each notice's language and version, when it was published, its review status in words, its purposes, and the id to give the SDK", async () => {
    page();
    const rows = await screen.findAllByRole("row");
    expect(rows[1]?.textContent).toContain("English, version 2");
    expect(rows[1]?.textContent).toContain(when(v2.publishedAt));
    expect(rows[1]?.textContent).toContain("Pending human review");
    expect(rows[1]?.textContent).toContain("analytics, marketing");
    expect(rows[1]?.textContent).toContain(N2);
    expect(rows[2]?.textContent).toContain("Hindi, version 1");
    expect(rows[2]?.textContent).toContain("Reviewed");
  });

  test("says so while loading and when there are none, and a failure can be retried", async () => {
    page({ "GET /v1/notices": [{ body: [], wait: Promise.resolve() }] });
    expect(screen.getByRole("status").textContent).toBe("Loading notices…");
    expect(await screen.findByText(/No notice has been published yet/)).toBeTruthy();
  });

  test("a failure is shown and Try again loads the list", async () => {
    page({ "GET /v1/notices": [{ status: 403, body: { message: "You do not have access to this." } }, { body: [v2] }] });
    expect((await screen.findByRole("alert")).textContent).toBe("You do not have access to this.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("rowheader", { name: "English, version 2" })).toBeTruthy();
  });
});

describe("publishing", () => {
  test("sends exactly what was filled in, shows the new version and its id, says it is pending review, and refreshes the list", async () => {
    const v = page({
      "POST /v1/notices": { status: 201, body: made },
      "GET /v1/notices": [{ body: [v2, v1] }, { body: [made, v2, v1] }],
    });
    await screen.findAllByRole("row");
    fillOrganisation();
    fillPurpose(1);
    publish();
    const heading = await screen.findByRole("heading", { name: "Published: English, version 3" });
    expect(document.activeElement).toBe(heading);
    expect(posted(v)).toHaveLength(1);
    expect((posted(v)[0] as Call).body).toEqual({
      language: "en",
      notice: {
        organisationName: "Example Controller Pvt Ltd", websiteUrl: "https://example.org", grievanceEmail: "privacy@example.org",
        grievanceAddress: "1 Example Road, Bengaluru 560001", thirdParties: [], processesChildrenData: false,
        withdrawalUrl: "https://example.org/privacy#withdraw", rightsRequestUrl: "https://example.org/privacy#rights",
      },
      purposes: [{
        key: "analytics", name: "Understand how the app is used", description: "We count which screens are opened.", dataItems: ["device type", "screens opened"],
        retention: "12 months", retentionDays: 365, purposeCategory: ["analytics"], piiCategory: ["device type"], thirdPartyDisclosure: false,
      }],
    });
    const panel = heading.closest("section") as HTMLElement;
    expect(panel.textContent).toContain(made.id);
    expect(panel.textContent).toMatch(/pending human review/i);
    expect(await screen.findByRole("rowheader", { name: "English, version 3" })).toBeTruthy();
  });

  test("what was typed stays in the form afterwards, so a small change can be published as the next version", async () => {
    page({ "POST /v1/notices": { status: 201, body: made } });
    await screen.findAllByRole("row");
    fillOrganisation();
    fillPurpose(1);
    publish();
    await screen.findByRole("heading", { name: /^Published: / });
    expect((screen.getByLabelText("Organisation name") as HTMLInputElement).value).toBe("Example Controller Pvt Ltd");
    expect((within(purpose(1)).getByLabelText("Key") as HTMLInputElement).value).toBe("analytics");
  });

  test("a form with gaps is turned back before anything is sent, listing every gap in words, and focus goes to the list", async () => {
    const v = page();
    await screen.findAllByRole("row");
    publish();
    const alert = await screen.findByRole("alert");
    expect(document.activeElement).toBe(alert);
    const items = within(alert).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toContain("Organisation name is required.");
    expect(items).toContain("Withdrawal link is required.");
    expect(items).toContain("Purpose 1: Key is required.");
    expect(items).toContain("Purpose 1: How long, in days must be a whole number of days from 0 to 36500.");
    expect(posted(v)).toHaveLength(0);
  });

  test("a refusal from the server names each problem in words, and the form is kept", async () => {
    page({
      "POST /v1/notices": {
        status: 400,
        body: { error: "invalid_request", field: "notice.websiteUrl", message: "must be an https URL without credentials", errors: [{ field: "notice.websiteUrl", message: "must be an https URL without credentials" }, { field: "purposes[0].retentionDays", message: "must be a whole number of days from 0 to 36500" }] },
      },
    });
    await screen.findAllByRole("row");
    fillOrganisation();
    fillPurpose(1);
    publish();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Website must be an https URL without credentials.",
      "Purpose 1: How long, in days must be a whole number of days from 0 to 36500.",
    ]);
    expect((screen.getByLabelText("Organisation name") as HTMLInputElement).value).toBe("Example Controller Pvt Ltd");
    expect(screen.queryByRole("heading", { name: /^Published: / })).toBeNull();
  });

  test("a notice that would make receipts too large is explained, and a lost connection is explained", async () => {
    const v = page({ "POST /v1/notices": [{ status: 422, body: { error: "receipt_too_large", message: "a receipt that grants every purpose would be about 17000 characters and a receipt may have at most 16384; use fewer or shorter purposes and categories" } }, { throws: true }] });
    await screen.findAllByRole("row");
    fillOrganisation();
    fillPurpose(1);
    publish();
    expect((await screen.findByRole("alert")).textContent).toContain("use fewer or shorter purposes and categories");
    await publishAgain();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("We could not reach the server"));
    expect(posted(v)).toHaveLength(2);
  });

  test("a second click while the first is in flight sends nothing more, and the button says it is working", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const v = page({ "POST /v1/notices": { status: 201, body: made, wait: gate } });
    await screen.findAllByRole("row");
    fillOrganisation();
    fillPurpose(1);
    publish();
    const busy = await screen.findByRole("button", { name: "Publishing…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(busy);
    fireEvent.submit(busy.closest("form") as HTMLFormElement); // pressing Enter in a field submits without the button
    release();
    await screen.findByRole("heading", { name: /^Published: / });
    expect(posted(v)).toHaveLength(1);
  });

  test("the language can be Hindi", async () => {
    const v = page({ "POST /v1/notices": { status: 201, body: { ...made, language: "hi" } } });
    await screen.findAllByRole("row");
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "hi" } });
    fillOrganisation();
    fillPurpose(1);
    publish();
    expect(await screen.findByRole("heading", { name: "Published: Hindi, version 3" })).toBeTruthy();
    expect(((posted(v)[0] as Call).body as { language: string }).language).toBe("hi");
  });

  test("a later failure hides the published panel, so it never sits beside an error about a different attempt", async () => {
    page({ "POST /v1/notices": [{ status: 201, body: made }, { status: 400, body: { message: "Check what you entered and try again." } }] });
    await screen.findAllByRole("row");
    fillOrganisation();
    fillPurpose(1);
    publish();
    await screen.findByRole("heading", { name: /^Published: / });
    await publishAgain();
    await screen.findByRole("alert");
    expect(screen.queryByRole("heading", { name: /^Published: / })).toBeNull();
  });
});

describe("purposes", () => {
  test("a purpose can be added and removed, the others keep what was typed, and the last one cannot be removed", async () => {
    page();
    await screen.findAllByRole("row");
    expect(screen.queryByRole("button", { name: /^Remove purpose/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add a purpose" }));
    fireEvent.click(screen.getByRole("button", { name: "Add a purpose" }));
    fillPurpose(1, { Key: "first" });
    fillPurpose(2, { Key: "second" });
    fillPurpose(3, { Key: "third" });
    fireEvent.click(screen.getByRole("button", { name: "Remove purpose 2" }));
    expect(screen.getAllByRole("group", { name: /^Purpose \d$/ })).toHaveLength(2);
    expect((within(purpose(1)).getByLabelText("Key") as HTMLInputElement).value).toBe("first");
    expect((within(purpose(2)).getByLabelText("Key") as HTMLInputElement).value).toBe("third");
    fireEvent.click(screen.getByRole("button", { name: "Remove purpose 2" }));
    expect(screen.queryByRole("button", { name: /^Remove purpose/ })).toBeNull();
  });

  test("no more than 30 purposes can be added", async () => {
    page();
    await screen.findAllByRole("row");
    for (let i = 0; i < 29; i++) fireEvent.click(screen.getByRole("button", { name: "Add a purpose" }));
    expect(screen.getAllByRole("group", { name: /^Purpose \d+$/ })).toHaveLength(30);
    expect((screen.getByRole("button", { name: "Add a purpose" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("a purpose is shared with a third party only by choosing one of those listed for the notice", async () => {
    const v = page({ "POST /v1/notices": { status: 201, body: made } });
    await screen.findAllByRole("row");
    expect(within(purpose(1)).queryByLabelText("Third party it is disclosed to")).toBeNull();
    fireEvent.click(within(purpose(1)).getByLabelText("Shared with a third party"));
    expect(within(purpose(1)).getByText(/List the organisations under “Third parties” first/)).toBeTruthy();
    fill("Third parties", "Example Analytics Ltd\nOther Ltd");
    const select = within(purpose(1)).getByLabelText("Third party it is disclosed to") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Choose…", "Example Analytics Ltd", "Other Ltd"]);
    fireEvent.change(select, { target: { value: "Example Analytics Ltd" } });
    fillOrganisation();
    fillPurpose(1);
    publish();
    await screen.findByRole("heading", { name: /^Published: / });
    expect(((posted(v)[0] as Call).body as { purposes: unknown[] }).purposes[0]).toMatchObject({ thirdPartyDisclosure: true, thirdPartyName: "Example Analytics Ltd" });
  });

  test("a third party removed from the list after being chosen is turned back, not sent", async () => {
    const v = page();
    await screen.findAllByRole("row");
    fillOrganisation();
    fillPurpose(1);
    fill("Third parties", "Example Analytics Ltd");
    fireEvent.click(within(purpose(1)).getByLabelText("Shared with a third party"));
    fireEvent.change(within(purpose(1)).getByLabelText("Third party it is disclosed to"), { target: { value: "Example Analytics Ltd" } });
    fill("Third parties", "Other Ltd");
    expect((within(purpose(1)).getByLabelText("Third party it is disclosed to") as HTMLSelectElement).value).toBe("");
    publish();
    expect((await screen.findByRole("alert")).textContent).toContain("Purpose 1: Third party must be one of the third parties listed for the notice.");
    expect(posted(v)).toHaveLength(0);
  });

  test("turning the third-party box off and on again does not bring back the earlier choice", async () => {
    page();
    await screen.findAllByRole("row");
    fill("Third parties", "Example Analytics Ltd");
    const box = within(purpose(1)).getByLabelText("Shared with a third party");
    fireEvent.click(box);
    fireEvent.change(within(purpose(1)).getByLabelText("Third party it is disclosed to"), { target: { value: "Example Analytics Ltd" } });
    fireEvent.click(box);
    fireEvent.click(box);
    expect((within(purpose(1)).getByLabelText("Third party it is disclosed to") as HTMLSelectElement).value).toBe("");
  });

  test("an address the browser would call invalid is still sent, so the server's wording is what the person reads", async () => {
    const v = page({ "POST /v1/notices": { status: 400, body: { error: "invalid_request", field: "notice.websiteUrl", message: "must be an https URL without credentials" } } });
    await screen.findAllByRole("row");
    fillOrganisation();
    fillPurpose(1);
    fill("Website", "example.org");
    publish();
    expect((await screen.findByRole("alert")).textContent).toContain("Website must be an https URL without credentials.");
    expect(posted(v)).toHaveLength(1);
  });

  test("each new refusal takes focus again, even when focus had moved to a field", async () => {
    page({ "POST /v1/notices": { status: 400, body: { message: "Check what you entered and try again." } } });
    await screen.findAllByRole("row");
    fillOrganisation();
    fillPurpose(1);
    publish();
    const first = await screen.findByRole("alert");
    expect(document.activeElement).toBe(first);
    (screen.getByLabelText("Organisation name") as HTMLInputElement).focus();
    await publishAgain();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("alert")));
  });

  test("a successful publication clears an earlier refusal", async () => {
    page({ "POST /v1/notices": [{ status: 400, body: { message: "Check what you entered and try again." } }, { status: 201, body: made }] });
    await screen.findAllByRole("row");
    fillOrganisation();
    fillPurpose(1);
    publish();
    await screen.findByRole("alert");
    await publishAgain();
    await screen.findByRole("heading", { name: /^Published: / });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("children's data and the officer's name are sent when given", async () => {
    const v = page({ "POST /v1/notices": { status: 201, body: made } });
    await screen.findAllByRole("row");
    fillOrganisation();
    fillPurpose(1);
    fill("Name of the data protection officer (optional)", "A. Officer");
    fireEvent.click(screen.getByLabelText("We collect data about children"));
    publish();
    await screen.findByRole("heading", { name: /^Published: / });
    expect(((posted(v)[0] as Call).body as { notice: unknown }).notice).toMatchObject({ dpoName: "A. Officer", processesChildrenData: true });
  });
});
