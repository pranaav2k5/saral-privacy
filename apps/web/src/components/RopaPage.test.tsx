import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { RopaPage } from "./RopaPage";
import { dayLabel, when } from "@/lib/format";
import { FIDUCIARY_WORDS, LEGAL_BASIS_WORDS, MEASURE_WORDS, ROLE_WORDS, SOURCE_WORDS } from "@/lib/ropa-form";
import { renderScreen, type Route } from "@/test/harness";
import type { RopaDocument, RopaVersion } from "@/lib/api";

const DOC: RopaDocument = {
  schema: "saral.ropa/1",
  organisation: { name: "Example Traders", address: "1 Market Road, Pune", contactName: "A. Rao", contactEmail: "dpo@example.org", sector: "Retail", significantDataFiduciary: "no" },
  review: { lastReviewedOn: "2026-10-01", nextReviewDue: "2099-01-01" },
  activities: [{
    name: "Payroll", description: "Paying staff each month.", purposes: ["Pay salaries", "File tax returns"], legalBasis: "legitimate_use", principals: ["Employees"],
    personalData: ["Name", "Bank account number"], involvesChildren: false, source: "directly_from_person", recipients: [{ name: "Acme Bank", role: "processor", country: "IN" }],
    crossBorder: true, transferCountries: ["US", "SG", "IN"], retention: "Seven years after the person leaves.", securityMeasures: ["encryption_in_transit", "access_control", "backups"],
    otherMeasures: "Locked cabinet", storage: "Cloud accounting software", owner: "Finance manager",
  }],
  notes: "Reviewed with the board.",
};
const DOC1: RopaDocument = { ...DOC, organisation: { ...DOC.organisation, name: "Old Traders" } };
const V2: RopaVersion = { id: "v2", version: 2, createdAt: "2026-11-05T09:00:00.000Z", createdBy: "staff:dpo", note: "Added payroll", sha256: "a".repeat(64) };
const V1: RopaVersion = { id: "v1", version: 1, createdAt: "2026-10-01T09:00:00.000Z", createdBy: "staff:admin", note: null, sha256: "b".repeat(64) };

const page = (routes: Record<string, Route | Route[]> = {}, role: "dpo" | "tenant_admin" = "dpo") =>
  renderScreen(<RopaPage />, {
    role,
    routes: { "GET /v1/ropa": { body: [V2, V1] }, "GET /v1/ropa/latest": { body: { ...V2, document: DOC } }, "GET /v1/ropa/v1": { body: { ...V1, document: DOC1 } }, ...routes },
  });
const empty = (routes: Record<string, Route | Route[]> = {}) => page({ "GET /v1/ropa": { body: [] }, ...routes });
const fill = (scope: HTMLElement | typeof screen, label: string | RegExp, value: string) => fireEvent.change(within(scope as HTMLElement).getByLabelText(label), { target: { value } });
const choose = (scope: HTMLElement, legend: string | RegExp, label: string | RegExp) => fireEvent.click(within(within(scope).getByRole("group", { name: legend })).getByLabelText(label));
const tick = (scope: HTMLElement, label: string) => fireEvent.click(within(scope).getByLabelText(label));
const next = () => fireEvent.click(screen.getByRole("button", { name: "Next" }));
const heading = (name: string) => screen.getByRole("heading", { name });

const fillOrganisation = (over: Record<string, string> = {}) => {
  const body = document.body;
  fill(body, "Name of the organisation", over.name ?? "Example Traders");
  fill(body, "Address", "1 Market Road, Pune");
  fill(body, "Contact person", "A. Rao");
  fill(body, "Contact email", "dpo@example.org");
  fill(body, "Line of business", "Retail");
  choose(body, /significant data fiduciary/, FIDUCIARY_WORDS.no);
  fill(body, "Date of the last review", "2026-10-01");
  fill(body, "Next review due (optional)", "2099-01-01");
};
const activityBox = (n: number): HTMLElement => screen.getAllByRole("group", { name: new RegExp(`^Activity ${String(n)}`) })[0] as HTMLElement;
const fillActivity = (box: HTMLElement, over: { name?: string } = {}) => {
  fill(box, "Name of the activity", over.name ?? "Payroll");
  fill(box, "What the organisation does with the data", "Paying staff each month.");
  fill(box, "Why it is done (one reason on each line)", "Pay salaries\nFile tax returns");
  choose(box, "Why it is allowed", LEGAL_BASIS_WORDS.legitimate_use);
  fill(box, /Whose data it is/, "Employees");
  fill(box, /What data is kept/, "Name\nBank account number");
  choose(box, "Is the data of children involved?", "No");
  choose(box, "Where the data comes from", SOURCE_WORDS.directly_from_person);
  fireEvent.click(within(box).getByRole("button", { name: "Add a recipient" }));
  fill(box, "Recipient 1: name", "Acme Bank");
  choose(box, "Recipient 1: what it is", ROLE_WORDS.processor);
  fill(box, "Recipient 1: country code", "in");
  choose(box, "Is data sent to another country?", "Yes");
  fill(box, "Which countries", "us, sg, IN");
  fill(box, "How long it is kept, and what happens then", "Seven years after the person leaves.");
  tick(box, MEASURE_WORDS.encryption_in_transit);
  tick(box, MEASURE_WORDS.access_control);
  tick(box, MEASURE_WORDS.backups);
  fill(box, "Other ways it is protected (optional)", "Locked cabinet");
  fill(box, "Where it is kept", "Cloud accounting software");
  fill(box, "Who is responsible for it", "Finance manager");
};
/** Fills every step of a new record and stops on the last step. */
const reachCheckStep = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Start the record" }));
  fillOrganisation();
  next();
  fillActivity(activityBox(1));
  fill(document.body, "Notes (optional)", "Reviewed with the board.");
  next();
  heading("Check and save");
};

describe("opening the page", () => {
  test("while loading it says so, a failure shows its words and can be tried again, and with none it offers to start", async () => {
    empty({ "GET /v1/ropa": [{ status: 500, body: { message: "The database is busy." } }, { body: [] }] });
    expect(screen.getByText("Loading the record…")).toBeTruthy();
    expect((await screen.findByText("The database is busy.")).closest("[role=alert]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No record has been saved yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start the record" })).toBeTruthy();
  });

  test("says up front that Saral keeps every version, does not check the answers and sends nothing", async () => {
    empty();
    await screen.findByText("No record has been saved yet");
    expect(screen.getByText(/Saral keeps each saved version and never changes one/)).toBeTruthy();
    expect(screen.getByText(/does not check that your answers are right/)).toBeTruthy();
    expect(screen.getByText(/does not send this record anywhere/)).toBeTruthy();
  });

  test.each(["dpo", "tenant_admin"] as const)("an %s sees the current record", async (role) => {
    page({}, role);
    expect(await screen.findByText("Version 2 (the current one)")).toBeTruthy();
  });
});

describe("reading the record", () => {
  test("shows the newest version with the organisation, each activity and its answers in words, and no code names", async () => {
    page();
    const region = await screen.findByRole("region", { name: "Activity 1: Payroll" });
    const org = screen.getByRole("region", { name: "The organisation" });
    expect(org.textContent).toContain("Example Traders");
    expect(org.textContent).toContain("1 Market Road, Pune");
    expect(org.textContent).toContain("A. Rao, dpo@example.org");
    expect(org.textContent).toContain("Retail");
    expect(org.textContent).toContain("Last reviewed" + dayLabel("2026-10-01"));
    expect(org.textContent).toMatch(/Next review due .* \(in \d+ days\)\./);
    const text = region.textContent ?? "";
    for (const part of [
      "Paying staff each month.", "Pay salaries, File tax returns", LEGAL_BASIS_WORDS.legitimate_use, "Employees", "Name, Bank account number", "Children's dataNo", SOURCE_WORDS.directly_from_person,
      "Acme Bank (IN, processor)", "Sent to another countryYes: US, SG, IN", "Seven years after the person leaves.",
      `${MEASURE_WORDS.encryption_in_transit}, ${MEASURE_WORDS.access_control}, ${MEASURE_WORDS.backups}, Locked cabinet`, "Cloud accounting software", "Finance manager",
    ]) expect(text).toContain(part);
    expect(document.body.textContent).not.toMatch(/legitimate_use|directly_from_person|encryption_in_transit|third_party/);
    expect(screen.getByRole("region", { name: "Notes" }).textContent).toContain("Reviewed with the board.");
  });

  test("does not claim anything was just saved when the page is opened", async () => {
    page();
    await screen.findByText("Version 2 (the current one)");
    expect(screen.queryByText(/Saved as version/)).toBeNull();
  });

  test("shows who saved the version, when, the note and the fingerprint, and lists every version with its note", async () => {
    page();
    await screen.findByText("Version 2 (the current one)");
    expect(screen.getByText(/Saved .* by staff:dpo\./).textContent).toContain(when(V2.createdAt));
    expect(screen.getByText(/Note: Added payroll\./)).toBeTruthy();
    expect(screen.getByText("a".repeat(64)).tagName).toBe("CODE");
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[1]?.textContent).toContain("2");
    expect(rows[1]?.textContent).toContain("staff:dpo");
    expect(rows[1]?.textContent).toContain("Added payroll");
    expect(rows[2]?.textContent).toContain("staff:admin");
    expect(rows[2]?.textContent).toContain(when(V1.createdAt));
  });

  test("an overdue review is said to be overdue in words", async () => {
    page({ "GET /v1/ropa/latest": { body: { ...V2, document: { ...DOC, review: { lastReviewedOn: "2020-01-01", nextReviewDue: "2020-06-01" } } } } });
    expect((await screen.findByText(/overdue by \d+ days/)).textContent).toContain("Next review was due");
  });

  test("an older version can be looked at, says it is not the current one, and the current one can be shown again", async () => {
    const r = page();
    await screen.findByText("Version 2 (the current one)");
    fireEvent.click(screen.getByRole("button", { name: "View version 1" }));
    expect(await screen.findByText("Version 1")).toBeTruthy();
    expect(screen.queryByText(/the current one/)).toBeNull();
    expect(screen.getByRole("region", { name: "The organisation" }).textContent).toContain("Old Traders");
    expect(r.callsTo("GET", "/v1/ropa/v1")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "View version 2" }));
    expect(await screen.findByText("Version 2 (the current one)")).toBeTruthy();
  });

  test("markup in a saved record is shown as text and never runs, and the website is text, not a link", async () => {
    const markup = '<img src=x onerror="document.title=1"><script>document.title=2</script>';
    const hostile: RopaDocument = {
      ...DOC, organisation: { ...DOC.organisation, name: markup, website: "https://example.org/?a=<b>x</b>" },
      activities: [{ ...(DOC.activities[0] as RopaDocument["activities"][number]), name: markup, description: markup, purposes: [markup], recipients: [{ name: markup, role: "processor", country: "IN" }] }], notes: markup,
    };
    page({ "GET /v1/ropa/latest": { body: { ...V2, document: hostile } }, "GET /v1/ropa": { body: [{ ...V2, note: markup }] } });
    await screen.findByText("Version 2 (the current one)");
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(document.title).not.toBe("1");
    expect(screen.getByRole("region", { name: "The organisation" }).textContent).toContain(markup);
    expect(screen.getByText("https://example.org/?a=<b>x</b>").closest("a")).toBeNull();
    expect(screen.getAllByRole("link").map((l) => l.textContent)).toEqual(["Download as JSON"]);
  });

  test("the record can be kept as a JSON file made in the browser, named for its version, holding exactly the record", async () => {
    page();
    const link = (await screen.findByRole("link", { name: "Download as JSON" })) as HTMLAnchorElement;
    expect(link.getAttribute("download")).toBe("saral-ropa-version-2.json");
    const href = link.getAttribute("href") ?? "";
    expect(href.startsWith("data:application/json;charset=utf-8,")).toBe(true);
    const body = decodeURIComponent(href.slice("data:application/json;charset=utf-8,".length));
    expect(JSON.parse(body)).toEqual(DOC);
    expect(body).toContain("\n  ");
    expect(body.endsWith("\n")).toBe(true);
  });

  test("Print opens the browser's print window, and everything but the record is left out of the print", async () => {
    const print = jest.spyOn(window, "print").mockImplementation(() => undefined);
    try {
      page();
      await screen.findByText("Version 2 (the current one)");
      fireEvent.click(screen.getByRole("button", { name: "Print" }));
      expect(print).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Print" }).closest(".print\\:hidden")).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Saved versions" }).closest(".print\\:hidden")).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Record of processing" }).closest(".print\\:hidden")).toBeTruthy();
      expect(screen.getByRole("region", { name: "The organisation" }).closest(".print\\:hidden")).toBeNull();
      expect(screen.getByRole("heading", { name: "Record of processing, version 2" }).className).toContain("print:block");
    } finally {
      print.mockRestore();
    }
  });
});

describe("writing the record, step by step", () => {
  test("starts on the first step, which names the steps, and moves the reader to the step's heading", async () => {
    empty();
    fireEvent.click(await screen.findByRole("button", { name: "Start the record" }));
    expect(document.activeElement).toBe(heading("About the organisation"));
    const steps = within(screen.getByRole("list", { name: "Steps" })).getAllByRole("listitem");
    expect(steps.map((s) => s.textContent)).toEqual(["Step 1 of 3: About the organisation", "Step 2 of 3: What is done with personal data", "Step 3 of 3: Check and save"]);
    expect(steps[0]?.getAttribute("aria-current")).toBe("step");
    expect(steps[1]?.getAttribute("aria-current")).toBeNull();
  });

  test("Next with the organisation empty names every gap in that step only, stays, and sends nothing", async () => {
    const r = empty();
    fireEvent.click(await screen.findByRole("button", { name: "Start the record" }));
    next();
    const alert = screen.getByRole("alert");
    for (const part of ["Name of the organisation", "Address", "Contact person", "Contact email", "Line of business", "significant data fiduciary", "Date of the last review"]) expect(alert.textContent).toContain(part);
    expect(alert.textContent).not.toContain("Activity 1");
    expect(heading("About the organisation")).toBeTruthy();
    expect(r.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  test("Next on the activities step names what is missing in the activity by its number, and stays", async () => {
    empty();
    fireEvent.click(await screen.findByRole("button", { name: "Start the record" }));
    fillOrganisation();
    next();
    expect(heading("What is done with personal data")).toBeTruthy();
    next();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Activity 1: Name of the activity: fill this in.");
    expect(alert.textContent).toContain("Activity 1: Choose the reason it is allowed.");
    expect(alert.textContent).toContain("Activity 1: Say whether the data of children is involved.");
    expect(heading("What is done with personal data")).toBeTruthy();
  });

  test("a problem in the first step is not shown again once it is put right, and Back keeps every answer", async () => {
    empty();
    fireEvent.click(await screen.findByRole("button", { name: "Start the record" }));
    fillOrganisation({ name: "" });
    next();
    expect(screen.getByRole("alert").textContent).toContain("Name of the organisation: fill this in.");
    fill(document.body, "Name of the organisation", "Example Traders");
    next();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect((screen.getByLabelText("Name of the organisation") as HTMLInputElement).value).toBe("Example Traders");
    expect((screen.getByLabelText("Date of the last review") as HTMLInputElement).value).toBe("2026-10-01");
    expect((within(within(document.body).getByRole("group", { name: /significant data fiduciary/ })).getByLabelText(FIDUCIARY_WORDS.no) as HTMLInputElement).checked).toBe(true);
  });

  test("Back from the last step returns to the activities with their answers, and Back again to the organisation", async () => {
    empty();
    await reachCheckStep();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(heading("What is done with personal data")).toBeTruthy();
    expect((within(activityBox(1)).getByLabelText("Name of the activity") as HTMLInputElement).value).toBe("Payroll");
    expect((screen.getByLabelText("Notes (optional)") as HTMLTextAreaElement).value).toBe("Reviewed with the board.");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(heading("About the organisation")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  test("the yes and no questions start unanswered, and the countries box is there only when data is sent abroad", async () => {
    empty();
    fireEvent.click(await screen.findByRole("button", { name: "Start the record" }));
    fillOrganisation();
    next();
    const box = activityBox(1);
    for (const radio of within(box).getAllByRole("radio")) expect((radio as HTMLInputElement).checked).toBe(false);
    expect(within(box).queryByLabelText("Which countries")).toBeNull();
    choose(box, "Is data sent to another country?", "Yes");
    expect(within(box).getByLabelText("Which countries")).toBeTruthy();
    choose(box, "Is data sent to another country?", "No");
    expect(within(box).queryByLabelText("Which countries")).toBeNull();
  });

  test("activities and recipients can be added and removed, removal is offered only when more than one is left, and the others keep their answers", async () => {
    empty();
    fireEvent.click(await screen.findByRole("button", { name: "Start the record" }));
    fillOrganisation();
    next();
    expect(screen.queryByRole("button", { name: /Remove activity/ })).toBeNull();
    fill(activityBox(1), "Name of the activity", "Payroll");
    fireEvent.click(screen.getByRole("button", { name: "Add an activity" }));
    fill(activityBox(2), "Name of the activity", "Newsletter");
    expect(screen.getAllByRole("group", { name: /^Activity \d/ }).map((g) => within(g).getByText(/^Activity \d/).textContent)).toEqual(["Activity 1: Payroll", "Activity 2: Newsletter"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove activity 1" }));
    expect(screen.queryByRole("button", { name: /Remove activity/ })).toBeNull();
    expect((within(activityBox(1)).getByLabelText("Name of the activity") as HTMLInputElement).value).toBe("Newsletter");

    const box = activityBox(1);
    for (const n of ["First", "Second", "Third"]) {
      fireEvent.click(within(box).getByRole("button", { name: "Add a recipient" }));
      fill(box, `Recipient ${n === "First" ? "1" : n === "Second" ? "2" : "3"}: name`, n);
    }
    fireEvent.click(within(box).getByRole("button", { name: "Remove recipient 2" }));
    expect((within(box).getByLabelText("Recipient 1: name") as HTMLInputElement).value).toBe("First");
    expect((within(box).getByLabelText("Recipient 2: name") as HTMLInputElement).value).toBe("Third");
    expect(within(box).queryByLabelText("Recipient 3: name")).toBeNull();
  });

  test("removing one of several activities from the middle keeps the others, in order, with their answers", async () => {
    empty();
    fireEvent.click(await screen.findByRole("button", { name: "Start the record" }));
    fillOrganisation();
    next();
    fill(activityBox(1), "Name of the activity", "Payroll");
    fireEvent.click(screen.getByRole("button", { name: "Add an activity" }));
    fill(activityBox(2), "Name of the activity", "Newsletter");
    fireEvent.click(screen.getByRole("button", { name: "Add an activity" }));
    fill(activityBox(3), "Name of the activity", "Orders");
    fireEvent.click(screen.getByRole("button", { name: "Remove activity 2" }));
    expect(screen.getAllByRole("group", { name: /^Activity \d/ }).map((g) => (within(g).getByLabelText("Name of the activity") as HTMLInputElement).value)).toEqual(["Payroll", "Orders"]);
  });

  test("the same question in two activities is two separate groups of choices, each keeping its own answer", async () => {
    empty();
    fireEvent.click(await screen.findByRole("button", { name: "Start the record" }));
    fillOrganisation();
    next();
    fireEvent.click(screen.getByRole("button", { name: "Add an activity" }));
    const [one, two] = [activityBox(1), activityBox(2)];
    choose(one, "Is the data of children involved?", "Yes");
    choose(two, "Is the data of children involved?", "No");
    const answer = (box: HTMLElement) => within(within(box).getByRole("group", { name: "Is the data of children involved?" })).getAllByRole("radio").map((r) => (r as HTMLInputElement).checked);
    expect(answer(one)).toEqual([true, false]);
    expect(answer(two)).toEqual([false, true]);
    const names = [one, two].map((b) => (within(within(b).getByRole("group", { name: "Is the data of children involved?" })).getAllByRole("radio")[0] as HTMLInputElement).name);
    expect(names[0]).not.toBe(names[1]);
    // Within one activity, each of the four radio questions (reason allowed, children, source, other country) is a group of its own.
    expect(new Set(within(one).getAllByRole("radio").map((r) => (r as HTMLInputElement).name)).size).toBe(4);
  });
});

describe("saving", () => {
  const SAVED = { ...V1 };
  const saving = (extra: Record<string, Route | Route[]> = {}) =>
    empty({
      "POST /v1/ropa": { status: 201, body: SAVED },
      "GET /v1/ropa": [{ body: [] }, { body: [V1] }],
      "GET /v1/ropa/latest": { body: { ...V1, document: DOC1 } },
      "GET /v1/ropa/v1": { body: { ...V1, document: DOC1 } },
      ...extra,
    });

  test("the last step shows the record as it will be saved, says what saving does, and offers a note", async () => {
    saving();
    await reachCheckStep();
    const org = screen.getByRole("region", { name: "The organisation" });
    expect(org.textContent).toContain("Example Traders");
    expect(screen.getByRole("region", { name: "Activity 1: Payroll" }).textContent).toContain("Acme Bank (IN, processor)");
    expect(screen.getByText(/Saving makes version 1\. A saved version is never changed or removed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save as version 1" })).toBeTruthy();
    expect(screen.getByLabelText("Note about this version (optional)")).toBeTruthy();
  });

  test("saving sends exactly the record that was shown, with the words as typed made tidy, and then shows the saved version", async () => {
    const r = saving();
    await reachCheckStep();
    fireEvent.click(screen.getByRole("button", { name: "Save as version 1" }));
    expect(await screen.findByText("Saved as version 1.")).toBeTruthy();
    const posts = r.callsTo("POST", "/v1/ropa");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ document: DOC, basedOn: 0 });
    expect(screen.getByText("Version 1 (the current one)")).toBeTruthy();
    expect(screen.queryByText("No record has been saved yet")).toBeNull();
  });

  test("the saved notice goes away when another version is looked at, and is not shown again on coming back", async () => {
    const NEW = { ...V2, id: "v3", version: 3 };
    page({
      "POST /v1/ropa": { status: 201, body: NEW },
      "GET /v1/ropa": [{ body: [V2, V1] }, { body: [NEW, V2, V1] }],
      "GET /v1/ropa/v3": { body: { ...NEW, document: DOC } },
      "GET /v1/ropa/v2": { body: { ...V2, document: DOC } },
      // The newest version is read from its own address: version 2 until version 3 is saved, and version 3 after.
      "GET /v1/ropa/latest": [{ body: { ...V2, document: DOC } }, { body: { ...NEW, document: DOC } }],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Update the record" }));
    fill(document.body, "Address", "2 New Road, Pune");
    next();
    next();
    fireEvent.click(screen.getByRole("button", { name: "Save as version 3" }));
    await screen.findByText("Saved as version 3.");
    fireEvent.click(screen.getByRole("button", { name: "View version 2" }));
    await screen.findByText("Version 2");
    expect(screen.queryByText(/Saved as version/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View version 3" }));
    await screen.findByText("Version 3 (the current one)");
    expect(screen.queryByText(/Saved as version/)).toBeNull();
  });

  test("while the list is read again after a save, the page says it is loading and never shows the old state", async () => {
    let release: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    saving({ "GET /v1/ropa": [{ body: [] }, { body: [V1], wait }] });
    await reachCheckStep();
    fireEvent.click(screen.getByRole("button", { name: "Save as version 1" }));
    expect(await screen.findByText("Loading the record…")).toBeTruthy();
    expect(screen.queryByText("No record has been saved yet")).toBeNull();
    release();
    expect(await screen.findByText("Saved as version 1.")).toBeTruthy();
  });

  test("a note is trimmed and sent with the record, and left out when empty", async () => {
    const r = saving();
    await reachCheckStep();
    fill(document.body, "Note about this version (optional)", "  First version  ");
    fireEvent.click(screen.getByRole("button", { name: "Save as version 1" }));
    await screen.findByText("Saved as version 1.");
    expect((r.callsTo("POST", "/v1/ropa")[0]?.body as { note?: string }).note).toBe("First version");
  });

  test("a note over 500 characters is refused before anything is sent, and 500 is fine", async () => {
    const r = saving();
    await reachCheckStep();
    fill(document.body, "Note about this version (optional)", "x".repeat(501));
    fireEvent.click(screen.getByRole("button", { name: "Save as version 1" }));
    expect(screen.getByRole("alert").textContent).toContain("Note: use at most 500 characters.");
    expect(r.callsTo("POST", "/v1/ropa")).toHaveLength(0);
    fill(document.body, "Note about this version (optional)", "x".repeat(500));
    fireEvent.click(screen.getByRole("button", { name: "Save as version 1" }));
    await screen.findByText("Saved as version 1.");
  });

  test("pressing save twice sends one request, and the button says it is saving", async () => {
    let release: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const r = saving({ "POST /v1/ropa": { status: 201, body: SAVED, wait } });
    await reachCheckStep();
    const save = screen.getByRole("button", { name: "Save as version 1" });
    fireEvent.click(save);
    fireEvent.click(save);
    // Pressing Enter in a box submits the form without clicking the button, which being disabled does not stop.
    fireEvent.submit(screen.getByRole("form", { name: "Check and save" }));
    expect((await screen.findByRole("button", { name: "Saving…" })).hasAttribute("disabled")).toBe(true);
    expect(r.callsTo("POST", "/v1/ropa")).toHaveLength(1);
    release();
    await screen.findByText("Saved as version 1.");
    expect(r.callsTo("POST", "/v1/ropa")).toHaveLength(1);
  });

  test.each([
    ["the record is unchanged", { status: 409, body: { error: "unchanged", message: "x" } }, "Nothing has changed since the last saved version, so nothing was saved."],
    ["the versions are used up", { status: 409, body: { error: "version_limit" } }, "200 versions have been saved"],
    ["the server refuses a field", { status: 400, body: { error: "invalid_request", field: "document.organisation.contactEmail", message: "must be an email address" } }, "Contact email must be an email address."],
    ["the server cannot be reached", { throws: true }, "could not reach the server"],
  ] as [string, Route, string][])("when %s, says so in words, keeps the form, and allows another try", async (_n, answer, words) => {
    const r = saving({ "POST /v1/ropa": [answer, { status: 201, body: SAVED }] });
    await reachCheckStep();
    fireEvent.click(screen.getByRole("button", { name: "Save as version 1" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent?.toLowerCase()).toContain(words.toLowerCase());
    expect(screen.getByRole("region", { name: "Activity 1: Payroll" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save as version 1" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Save as version 1" }));
    await screen.findByText("Saved as version 1.");
    expect(r.callsTo("POST", "/v1/ropa")).toHaveLength(2);
  });
});

describe("changing a saved record", () => {
  test("Update the record opens the questions with the saved answers, numbers the new version, and Cancel goes back without sending anything", async () => {
    const r = page();
    fireEvent.click(await screen.findByRole("button", { name: "Update the record" }));
    expect(heading("Update the record (a new version 3)")).toBeTruthy();
    expect((screen.getByLabelText("Name of the organisation") as HTMLInputElement).value).toBe("Example Traders");
    expect((screen.getByLabelText("Next review due (optional)") as HTMLInputElement).value).toBe("2099-01-01");
    next();
    const box = activityBox(1);
    expect((within(box).getByLabelText("Name of the activity") as HTMLInputElement).value).toBe("Payroll");
    expect((within(box).getByLabelText("Which countries") as HTMLInputElement).value).toBe("US, SG, IN");
    expect((within(box).getByLabelText(MEASURE_WORDS.backups) as HTMLInputElement).checked).toBe(true);
    expect((within(box).getByLabelText(MEASURE_WORDS.logging) as HTMLInputElement).checked).toBe(false);
    expect((within(box).getByLabelText("Recipient 1: name") as HTMLInputElement).value).toBe("Acme Bank");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Version 2 (the current one)")).toBeTruthy();
    expect(r.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  test("saving an update sends the whole changed record as the next version, and shows it", async () => {
    const NEW = { ...V2, id: "v3", version: 3, note: "Moved payroll" };
    const r = page({
      "POST /v1/ropa": { status: 201, body: NEW },
      "GET /v1/ropa": [{ body: [V2, V1] }, { body: [NEW, V2, V1] }],
      "GET /v1/ropa/v3": { body: { ...NEW, document: { ...DOC, organisation: { ...DOC.organisation, address: "2 New Road, Pune" } } } },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Update the record" }));
    fill(document.body, "Address", "2 New Road, Pune");
    next();
    next();
    fill(document.body, "Note about this version (optional)", "Moved payroll");
    fireEvent.click(screen.getByRole("button", { name: "Save as version 3" }));
    expect(await screen.findByText("Saved as version 3.")).toBeTruthy();
    expect(r.callsTo("POST", "/v1/ropa")[0]?.body).toEqual({ document: { ...DOC, organisation: { ...DOC.organisation, address: "2 New Road, Pune" } }, note: "Moved payroll", basedOn: 2 });
    expect(screen.getByText("Version 3 (the current one)")).toBeTruthy();
    expect(screen.getByRole("region", { name: "The organisation" }).textContent).toContain("2 New Road, Pune");
  });

  test("an update the server finds unchanged is said to be unchanged, not shown as saved", async () => {
    page({ "POST /v1/ropa": { status: 409, body: { error: "unchanged" } } });
    fireEvent.click(await screen.findByRole("button", { name: "Update the record" }));
    next();
    next();
    fireEvent.click(screen.getByRole("button", { name: "Save as version 3" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Nothing has changed since the last saved version");
    expect(screen.queryByText(/Saved as version/)).toBeNull();
  });

  test("an update that started from a version that is no longer the newest is refused in words, keeps the form, and can be tried again", async () => {
    const r = page({ "POST /v1/ropa": [{ status: 409, body: { error: "stale", latest: 3 } }, { status: 201, body: { ...V2, id: "v4", version: 4 } }] });
    fireEvent.click(await screen.findByRole("button", { name: "Update the record" }));
    fill(document.body, "Address", "2 New Road, Pune");
    next();
    next();
    fireEvent.click(screen.getByRole("button", { name: "Save as version 3" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Version 3 was saved by someone else after you started.");
    expect(screen.getByRole("region", { name: "The organisation" }).textContent).toContain("2 New Road, Pune");
    expect((screen.getByRole("button", { name: "Save as version 3" }) as HTMLButtonElement).disabled).toBe(false);
    expect(r.callsTo("POST", "/v1/ropa")).toHaveLength(1);
  });

  test("starting a new version from an older one still says it started from the newest, because that is what the person is replacing", async () => {
    const r = page({ "POST /v1/ropa": { status: 201, body: { ...V2, id: "v3", version: 3 } } });
    await screen.findByText("Version 2 (the current one)");
    fireEvent.click(screen.getByRole("button", { name: "View version 1" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start a new version from this one" }));
    next();
    next();
    fireEvent.click(screen.getByRole("button", { name: "Save as version 3" }));
    await waitFor(() => expect(r.callsTo("POST", "/v1/ropa")).toHaveLength(1));
    expect((r.callsTo("POST", "/v1/ropa")[0]?.body as { basedOn: number }).basedOn).toBe(2);
  });

  test("an older version can be the start of a new one: its answers fill the form, and the new version is still numbered after the newest", async () => {
    page();
    await screen.findByText("Version 2 (the current one)");
    fireEvent.click(screen.getByRole("button", { name: "View version 1" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start a new version from this one" }));
    expect(heading("Update the record (a new version 3)")).toBeTruthy();
    expect((screen.getByLabelText("Name of the organisation") as HTMLInputElement).value).toBe("Old Traders");
  });

  test("a record saved without the optional parts opens with those boxes empty and saves without them", async () => {
    const bare: RopaDocument = { schema: "saral.ropa/1", organisation: DOC.organisation, review: { lastReviewedOn: "2026-10-01" }, activities: [{ ...(DOC.activities[0] as RopaDocument["activities"][number]), otherMeasures: undefined }] };
    delete (bare.activities[0] as { otherMeasures?: string }).otherMeasures;
    const r = page({ "GET /v1/ropa/latest": { body: { ...V2, document: bare } }, "POST /v1/ropa": { status: 201, body: { ...V2, id: "v3", version: 3 } } });
    fireEvent.click(await screen.findByRole("button", { name: "Update the record" }));
    expect((screen.getByLabelText("Next review due (optional)") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Website (optional)") as HTMLInputElement).value).toBe("");
    fill(document.body, "Address", "2 New Road, Pune");
    next();
    expect((screen.getByLabelText("Notes (optional)") as HTMLTextAreaElement).value).toBe("");
    next();
    fireEvent.click(screen.getByRole("button", { name: "Save as version 3" }));
    await waitFor(() => expect(r.callsTo("POST", "/v1/ropa")).toHaveLength(1));
    const sent = (r.callsTo("POST", "/v1/ropa")[0]?.body as { document: RopaDocument }).document;
    expect(Object.keys(sent)).toEqual(["schema", "organisation", "review", "activities"]);
    expect(Object.keys(sent.review)).toEqual(["lastReviewedOn"]);
    expect(Object.keys(sent.activities[0] ?? {})).not.toContain("otherMeasures");
  });
});
