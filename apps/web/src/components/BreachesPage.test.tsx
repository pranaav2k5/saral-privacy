import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { BreachesPage } from "./BreachesPage";
import { when } from "@/lib/format";
import { renderScreen, type Route } from "@/test/harness";
import type { Breach } from "@/lib/api";

const breach = (over: Partial<Breach> = {}): Breach => ({
  id: "b1", state: "reported", title: "Laptop lost", description: "A laptop with a customer list was lost.", discoveredAt: "2026-11-06T09:00:00.000Z", occurredAt: null,
  nature: ["confidentiality"], dataCategories: ["phone numbers", "names"], approxPrincipalsAffected: 120, likelyConsequences: "Calls from strangers.", measuresTaken: "The laptop was wiped.",
  reportedAt: "2026-11-06T09:30:00.000Z", reportedBy: "staff:one", boardDeadline: "2099-11-09T09:00:00.000Z", boardOverdue: false, boardNotifiedLate: null, signedOffAt: null, signedOffBy: null,
  boardNotifiedAt: null, boardReference: null, principalsNotifiedAt: null, principalsHow: null, principalsCount: null, closedAt: null, closingNote: null, ...over,
});
/** An instant as a datetime-local box shows it, in the machine's own time zone, so the tests do not depend on where they run. */
const box = (iso: string): string => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getFullYear())}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const SIGNED = { state: "signed_off" as const, signedOffAt: "2026-11-06T10:00:00.000Z", signedOffBy: "staff:dpo" };
const BOARDED = { ...SIGNED, state: "board_notified" as const, boardNotifiedAt: "2026-11-06T11:00:00.000Z", boardReference: "DPB-1", boardNotifiedLate: false };
const TOLD = { principalsNotifiedAt: "2026-11-06T12:00:00.000Z", principalsHow: "Email to each person", principalsCount: 120 };
const HASHES = { boardSha256: "a".repeat(64), principalSha256: "b".repeat(64) };
const DRAFTS = { boardNotification: "DRAFT: for the Board.\nOrganisation: Example", principalNotice: "DRAFT: for the people.\nSubject: A security incident", boardDeadline: "2099-11-09T09:00:00.000Z", ...HASHES };

const page = (list: Breach[], routes: Record<string, Route | Route[]> = {}, role: "dpo" | "tenant_admin" = "dpo") =>
  renderScreen(<BreachesPage />, { role, routes: { "GET /v1/breaches": { body: list }, "GET /v1/breaches/b1/drafts": { body: DRAFTS }, ...routes } });
const open = async (title = "Laptop lost") => {
  fireEvent.click(await screen.findByRole("button", { name: `Open ${title}` }));
  return await screen.findByRole("region", { name: title });
};
const fill = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("the list", () => {
  test("shows each incident with when it was found, its state and the Board's deadline in words", async () => {
    page([breach(), breach({ id: "b2", title: "Mail misdirected", ...BOARDED })]);
    const rows = await screen.findAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[1]?.textContent).toContain("Laptop lost");
    expect(rows[1]?.textContent).toContain(when("2026-11-06T09:00:00.000Z"));
    expect(rows[1]?.textContent).toContain("Reported, waiting for sign-off");
    expect(rows[1]?.textContent).toMatch(/Board to be told in \d+ days/);
    expect(rows[2]?.textContent).toContain("Board told");
    expect(rows[2]?.textContent).toContain(when("2026-11-06T11:00:00.000Z"));
  });

  test("an overdue incident is said to be overdue in words, not only by colour", async () => {
    page([breach({ boardDeadline: "2020-01-01T00:00:00.000Z", boardOverdue: true })]);
    expect((await screen.findAllByRole("row"))[1]?.textContent).toMatch(/Board not told: \d+ days? late/);
  });

  test("while loading it says so, with none it says none, and a failure shows its words and can be tried again", async () => {
    page([], { "GET /v1/breaches": [{ status: 500, body: { message: "The database is busy." } }, { body: [] }] });
    expect(screen.getByText("Loading incidents…")).toBeTruthy();
    expect((await screen.findByText("The database is busy.")).closest("[role=alert]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No breach has been recorded.")).toBeTruthy();
  });

  test("says up front that nothing is sent for you, and that the 72 hours is a figure to confirm", async () => {
    page([]);
    await screen.findByText("No breach has been recorded.");
    expect(screen.getByText(/Saral does not send anything to the Board or to anyone/)).toBeTruthy();
    expect(screen.getByText(/72 hours is the working figure in our plan/)).toBeTruthy();
  });
});

describe("reporting a breach", () => {
  const form = () => {
    fireEvent.click(screen.getByRole("button", { name: "Report a breach" }));
    return screen.getByRole("form", { name: "Report a breach" });
  };
  const fillAll = () => {
    fill("Title", "  Laptop lost ");
    fill("What happened", "A laptop with a customer list was lost.");
    fill("When the organisation found out", box("2026-11-06T09:00:00Z"));
    fireEvent.click(screen.getByLabelText(/Someone who should not have seen it saw it/));
    fill(/Kinds of personal data/, "phone numbers\nnames");
    fill(/About how many people/, "120");
    fill("What could happen to the people affected", "Calls from strangers.");
    fill("What has been done about it", "The laptop was wiped.");
  };

  test("says every gap at once and sends nothing", async () => {
    const v = page([]);
    await screen.findByText("No breach has been recorded.");
    form();
    fireEvent.click(screen.getByRole("button", { name: "Record the breach" }));
    const alert = (await screen.findAllByRole("alert")).find((a) => a.textContent?.includes("Give the incident a short title.")) as HTMLElement;
    for (const words of ["Say what happened.", "Say when the organisation found out.", "Choose at least one way the data was affected.", "List at least one kind of personal data", "Say what could happen to the people affected.", "Say what has been done about it."]) {
      expect(alert.textContent).toContain(words);
    }
    expect(v.callsTo("POST", "/v1/breaches")).toHaveLength(0);
  });

  test("sends the request built from the form, then shows the new incident open and the list refreshed", async () => {
    const made = breach({ id: "new1", title: "Laptop lost" });
    const v = page([], { "POST /v1/breaches": { status: 201, body: made }, "GET /v1/breaches": [{ body: [] }, { body: [made] }], "GET /v1/breaches/new1/drafts": { body: DRAFTS } });
    await screen.findByText("No breach has been recorded.");
    form();
    fillAll();
    fireEvent.click(screen.getByRole("button", { name: "Record the breach" }));
    expect(await screen.findByRole("region", { name: "Laptop lost" })).toBeTruthy();
    const body = v.callsTo("POST", "/v1/breaches")[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ title: "Laptop lost", nature: ["confidentiality"], dataCategories: ["phone numbers", "names"], approxPrincipalsAffected: 120, likelyConsequences: "Calls from strangers.", measuresTaken: "The laptop was wiped." });
    expect(body.discoveredAt).toBe("2026-11-06T09:00:00.000Z");
    expect("occurredAt" in body).toBe(false);
    expect(screen.queryByRole("form", { name: "Report a breach" })).toBeNull();
    await waitFor(() => expect(v.callsTo("GET", "/v1/breaches")).toHaveLength(2));
  });

  test("a refusal by the server is shown in its words with the field named, and what was typed stays", async () => {
    page([], { "POST /v1/breaches": { status: 400, body: { error: "invalid_request", field: "dataCategories", message: "a kind is listed twice" } } });
    await screen.findByText("No breach has been recorded.");
    form();
    fillAll();
    fireEvent.click(screen.getByRole("button", { name: "Record the breach" }));
    expect((await screen.findAllByRole("alert")).some((a) => a.textContent === "Kinds of personal data: a kind is listed twice.")).toBe(true);
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("  Laptop lost ");
  });

  test("Cancel closes the form without sending", async () => {
    const v = page([]);
    await screen.findByText("No breach has been recorded.");
    form();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Report a breach" })).toBeNull();
    expect(v.callsTo("POST", "/v1/breaches")).toHaveLength(0);
  });

  test("while it is being recorded the button cannot be pressed again", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const v = page([], { "POST /v1/breaches": { status: 201, body: breach({ id: "new1" }), wait: gate }, "GET /v1/breaches/new1/drafts": { body: DRAFTS } });
    await screen.findByText("No breach has been recorded.");
    form();
    fillAll();
    const submit = screen.getByRole("button", { name: "Record the breach" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect((await screen.findByRole("button", { name: "Recording…" }) as HTMLButtonElement).disabled).toBe(true);
    release();
    await waitFor(() => expect(v.callsTo("POST", "/v1/breaches")).toHaveLength(1));
  });
});

describe("an incident opened", () => {
  test("shows what was reported in words, and the drafts for the Board and for the affected people", async () => {
    page([breach({ occurredAt: "2026-11-05T20:00:00.000Z", nature: ["confidentiality", "availability"] })]);
    const region = await open();
    expect(region.textContent).toContain("A laptop with a customer list was lost.");
    expect(region.textContent).toContain("Someone who should not have seen it saw it");
    expect(region.textContent).toContain("It could not be reached or was lost");
    expect(region.textContent).toContain("phone numbers");
    expect(region.textContent).toContain("About 120 people");
    expect(region.textContent).toContain("Calls from strangers.");
    expect(region.textContent).toContain("The laptop was wiped.");
    expect(region.textContent).toContain(when("2026-11-05T20:00:00.000Z"));
    expect(await within(region).findByText(/DRAFT: for the Board\./)).toBeTruthy();
    expect(within(region).getByRole("heading", { name: "For the Board" })).toBeTruthy();
    expect(within(region).getByRole("heading", { name: "For the affected people" })).toBeTruthy();
    expect(within(region).getByText(/DRAFT: for the people\./)).toBeTruthy();
  });

  test("says when a number or time is not known", async () => {
    page([breach({ approxPrincipalsAffected: null })]);
    const region = await open();
    expect(region.textContent).toContain("Not known yet");
    expect(region.textContent).toMatch(/It happened: not known/);
  });

  test("if the drafts cannot be made it says why, in the server's words", async () => {
    page([breach()], { "GET /v1/breaches/b1/drafts": { status: 422, body: { error: "incomplete_setup", message: "the organisation's profile does not say who the controller is" } } });
    const region = await open();
    expect((await within(region).findByText(/does not say who the controller is/)).closest("[role=alert]")).toBeTruthy();
  });

  test("Close hides it", async () => {
    page([breach()]);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Close this incident view" }));
    expect(screen.queryByRole("region", { name: "Laptop lost" })).toBeNull();
  });

  test("lists the steps with who did each and when, and what is still to do", async () => {
    page([breach({ ...BOARDED, ...TOLD })]);
    const region = await open();
    const steps = within(region).getByRole("list", { name: "Steps" });
    expect(steps.textContent).toContain("Reported");
    expect(steps.textContent).toContain(when("2026-11-06T09:30:00.000Z"));
    expect(steps.textContent).toContain("Signed off");
    expect(steps.textContent).toContain(when("2026-11-06T10:00:00.000Z"));
    expect(steps.textContent).toContain("Board told");
    expect(steps.textContent).toContain("DPB-1");
    expect(steps.textContent).toContain("Affected people told");
    expect(steps.textContent).toContain("Email to each person");
    expect(steps.textContent).toMatch(/Closed.*not yet/);
  });
});

describe("what each person may do", () => {
  test("the officer signs off, which sends the sign-off and shows the incident signed off", async () => {
    const v = page([breach()], { "POST /v1/breaches/b1/sign-off": { body: breach(SIGNED) }, "GET /v1/breaches": [{ body: [breach()] }, { body: [breach(SIGNED)] }] });
    const region = await open();
    await within(region).findByText(/DRAFT: for the Board\./);
    fireEvent.click(within(region).getByRole("button", { name: "Sign off the drafts" }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Laptop lost" })).queryByRole("button", { name: "Sign off the drafts" })).toBeNull());
    expect(v.callsTo("POST", "/v1/breaches/b1/sign-off")).toHaveLength(1);
    expect(v.callsTo("POST", "/v1/breaches/b1/sign-off")[0]?.body).toEqual(HASHES);
    expect(screen.getByRole("region", { name: "Laptop lost" }).textContent).toContain("Signed off");
  });

  test("while a step is being sent its button cannot be pressed again", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const v = page([breach()], { "POST /v1/breaches/b1/sign-off": { body: breach(SIGNED), wait: gate } });
    const region = await open();
    await within(region).findByText(/DRAFT: for the Board\./);
    const button = within(region).getByRole("button", { name: "Sign off the drafts" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect((within(region).getByRole("button", { name: "Sign off the drafts" }) as HTMLButtonElement).disabled).toBe(true);
    release();
    await waitFor(() => expect(v.callsTo("POST", "/v1/breaches/b1/sign-off")).toHaveLength(1));
  });

  test("the sign-off waits until the drafts are on screen, because it is given for the drafts that were read", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const v = page([breach()], { "GET /v1/breaches/b1/drafts": { body: DRAFTS, wait: gate } });
    const region = await open();
    const button = within(region).getByRole("button", { name: "Sign off the drafts" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(v.callsTo("POST", "/v1/breaches/b1/sign-off")).toHaveLength(0);
    release();
    await waitFor(() => expect((within(region).getByRole("button", { name: "Sign off the drafts" }) as HTMLButtonElement).disabled).toBe(false));
  });

  test("when the drafts have changed since they were opened the refusal is shown and the new drafts are read again, not signed", async () => {
    const newer = { ...DRAFTS, boardNotification: "DRAFT: for the Board.\nA changed account.", boardSha256: "c".repeat(64) };
    const v = page([breach()], {
      "GET /v1/breaches/b1/drafts": [{ body: DRAFTS }, { body: newer }],
      "POST /v1/breaches/b1/sign-off": { status: 409, body: { error: "drafts_changed", message: "the drafts are not the ones you read: the report was changed after you opened them. Read them again, then sign off again" } },
    });
    const region = await open();
    await within(region).findByText(/DRAFT: for the Board\./);
    fireEvent.click(within(region).getByRole("button", { name: "Sign off the drafts" }));
    expect((await within(region).findByText(/not the ones you read/)).closest("[role=alert]")).toBeTruthy();
    expect(await within(region).findByText(/A changed account\./)).toBeTruthy();
    expect(v.callsTo("GET", "/v1/breaches/b1/drafts")).toHaveLength(2);
    expect(within(region).getByRole("button", { name: "Sign off the drafts" })).toBeTruthy();
  });

  test("an administrator can report and correct but not sign off, tell the Board or close, and is told why", async () => {
    page([breach(), breach({ id: "b2", title: "Signed one", ...SIGNED })], {}, "tenant_admin");
    const region = await open();
    expect(within(region).queryByRole("button", { name: "Sign off the drafts" })).toBeNull();
    expect(within(region).getByRole("button", { name: "Correct this report" })).toBeTruthy();
    expect(region.textContent).toContain("Only the data protection officer can sign off, record what was sent, or close an incident.");
    expect(screen.getByRole("button", { name: "Report a breach" })).toBeTruthy();
  });

  test("the sign-off button is not offered again once signed off, and the report can no longer be corrected", async () => {
    page([breach(SIGNED)]);
    const region = await open();
    expect(within(region).queryByRole("button", { name: "Sign off the drafts" })).toBeNull();
    expect(within(region).queryByRole("button", { name: "Correct this report" })).toBeNull();
  });

  test("a refusal of a step is shown in the server's words and the incident stays as it was", async () => {
    page([breach()], { "POST /v1/breaches/b1/sign-off": { status: 409, body: { error: "illegal_transition", message: "an incident cannot move from signed_off to signed_off" } } });
    const region = await open();
    await within(region).findByText(/DRAFT: for the Board\./);
    fireEvent.click(within(region).getByRole("button", { name: "Sign off the drafts" }));
    expect((await within(region).findByText(/cannot move from signed_off to signed_off/)).closest("[role=alert]")).toBeTruthy();
    expect(within(region).getByRole("button", { name: "Sign off the drafts" })).toBeTruthy();
  });
});

describe("correcting a report", () => {
  test("the form is filled in, only what was changed is sent, and the view returns with the new text", async () => {
    const changed = breach({ description: "A different account of it." });
    const v = page([breach()], { "PATCH /v1/breaches/b1": { body: changed }, "GET /v1/breaches": [{ body: [breach()] }, { body: [changed] }] });
    const region = await open();
    fireEvent.click(within(region).getByRole("button", { name: "Correct this report" }));
    expect((screen.getByLabelText("What happened") as HTMLTextAreaElement).value).toBe("A laptop with a customer list was lost.");
    fill("What happened", " A different account of it. ");
    fireEvent.click(screen.getByRole("button", { name: "Save the correction" }));
    expect(await screen.findByText("A different account of it.")).toBeTruthy();
    expect(v.callsTo("PATCH", "/v1/breaches/b1")[0]?.body).toEqual({ description: "A different account of it." });
  });

  test("saving with nothing changed says so and sends nothing", async () => {
    const v = page([breach()]);
    const region = await open();
    fireEvent.click(within(region).getByRole("button", { name: "Correct this report" }));
    fireEvent.click(screen.getByRole("button", { name: "Save the correction" }));
    expect(await screen.findByText("Nothing was changed.")).toBeTruthy();
    expect(v.callsTo("PATCH", "/v1/breaches/b1")).toHaveLength(0);
  });

  test("the server's refusal is shown in its words", async () => {
    page([breach()], { "PATCH /v1/breaches/b1": { status: 409, body: { error: "locked", message: "an incident cannot be changed once it has been signed off" } } });
    const region = await open();
    fireEvent.click(within(region).getByRole("button", { name: "Correct this report" }));
    fill("Title", "Another title");
    fireEvent.click(screen.getByRole("button", { name: "Save the correction" }));
    expect((await screen.findAllByRole("alert")).some((a) => a.textContent === "an incident cannot be changed once it has been signed off")).toBe(true);
  });
});

describe("telling the Board", () => {
  const ready = () => page([breach(SIGNED)], { "POST /v1/breaches/b1/board-notified": { body: breach(BOARDED) }, "GET /v1/breaches": [{ body: [breach(SIGNED)] }, { body: [breach(BOARDED)] }] });

  test("is recorded with the time and the Board's reference, and the step then shows as done", async () => {
    const v = ready();
    const region = await open();
    fill("When you told the Board", box("2026-11-06T09:30:00Z"));
    fill("Reference the Board gave", " DPB-1 ");
    fireEvent.click(within(region).getByRole("button", { name: "Record that the Board was told" }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Laptop lost" })).queryByRole("button", { name: "Record that the Board was told" })).toBeNull());
    expect(v.callsTo("POST", "/v1/breaches/b1/board-notified")[0]?.body).toEqual({ notifiedAt: "2026-11-06T09:30:00.000Z", reference: "DPB-1" });
    expect(screen.getByRole("region", { name: "Laptop lost" }).textContent).toContain("DPB-1");
  });

  test("a missing time or reference is said before anything is sent", async () => {
    const v = ready();
    const region = await open();
    fireEvent.click(within(region).getByRole("button", { name: "Record that the Board was told" }));
    const alert = await within(region).findByRole("alert");
    expect(alert.textContent).toContain("Say when you told the Board.");
    expect(alert.textContent).toContain("Enter the reference the Board gave.");
    expect(v.callsTo("POST", "/v1/breaches/b1/board-notified")).toHaveLength(0);
  });

  test("is not offered before sign-off or after the Board was told, and says Saral has sent nothing", async () => {
    page([breach()]);
    const unsigned = await open();
    expect(within(unsigned).queryByRole("button", { name: "Record that the Board was told" })).toBeNull();
  });

  test("a form that says Saral sent nothing is shown to the officer after sign-off", async () => {
    ready();
    const region = await open();
    expect(region.textContent).toContain("Saral has not sent anything to the Board. Send the draft yourselves, then record here that you did.");
  });
});

describe("telling the affected people", () => {
  test("is recorded after sign-off, before or after the Board, and shows as done", async () => {
    const v = page([breach(SIGNED)], { "POST /v1/breaches/b1/principals-notified": { body: breach({ ...SIGNED, ...TOLD }) }, "GET /v1/breaches": [{ body: [breach(SIGNED)] }, { body: [breach({ ...SIGNED, ...TOLD })] }] });
    const region = await open();
    fill("How the people were told", " Email to each person ");
    fill("How many people were told", "120");
    fireEvent.click(within(region).getByRole("button", { name: "Record that the people were told" }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Laptop lost" })).queryByRole("button", { name: "Record that the people were told" })).toBeNull());
    expect(v.callsTo("POST", "/v1/breaches/b1/principals-notified")[0]?.body).toEqual({ how: "Email to each person", count: 120 });
  });

  test("is also offered after the Board was told, and a missing answer is said before anything is sent", async () => {
    const v = page([breach(BOARDED)]);
    const region = await open();
    fireEvent.click(within(region).getByRole("button", { name: "Record that the people were told" }));
    const alert = await within(region).findByRole("alert");
    expect(alert.textContent).toContain("Say how the people were told.");
    expect(alert.textContent).toContain("Say how many people were told (0 if nobody was affected).");
    expect(v.callsTo("POST", "/v1/breaches/b1/principals-notified")).toHaveLength(0);
  });

  test("is not offered before sign-off", async () => {
    page([breach()]);
    expect(within(await open()).queryByRole("button", { name: "Record that the people were told" })).toBeNull();
  });
});

describe("closing", () => {
  test("is offered only when the Board and the people have both been told, with a note", async () => {
    const v = page([breach({ ...BOARDED, ...TOLD })], { "POST /v1/breaches/b1/close": { body: breach({ ...BOARDED, ...TOLD, state: "closed", closedAt: "2026-11-07T09:00:00.000Z", closingNote: "Done." }) } });
    const region = await open();
    fill("Closing note", " Done. ");
    fireEvent.click(within(region).getByRole("button", { name: "Close the incident" }));
    await waitFor(() => expect(v.callsTo("POST", "/v1/breaches/b1/close")).toHaveLength(1));
    expect(v.callsTo("POST", "/v1/breaches/b1/close")[0]?.body).toEqual({ note: "Done." });
  });

  test("is not offered while the people have not been told, or the Board has not", async () => {
    page([breach(BOARDED), breach({ id: "b2", title: "Other", ...SIGNED, ...TOLD })]);
    expect(within(await open()).queryByRole("button", { name: "Close the incident" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close this incident view" }));
    expect(within(await open("Other")).queryByRole("button", { name: "Close the incident" })).toBeNull();
  });

  test("a note is required", async () => {
    const v = page([breach({ ...BOARDED, ...TOLD })]);
    const region = await open();
    fireEvent.click(within(region).getByRole("button", { name: "Close the incident" }));
    expect((await within(region).findByRole("alert")).textContent).toBe("Write a short closing note.");
    expect(v.callsTo("POST", "/v1/breaches/b1/close")).toHaveLength(0);
  });

  test("a closed incident shows its note and offers nothing more", async () => {
    page([breach({ ...BOARDED, ...TOLD, state: "closed", closedAt: "2026-11-07T09:00:00.000Z", closingNote: "Laptop recovered." })]);
    const region = await open();
    expect(region.textContent).toContain("Laptop recovered.");
    expect(within(region).queryAllByRole("button", { name: /^(Sign off|Record that|Close the incident|Correct)/ })).toHaveLength(0);
  });
});
