import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { noticeSha256, renderNotice, validateNoticeInput } from "@saral/notice";
import NoticeForm from "./notice-form";

const VALUES: Record<string, string> = {
  "Organisation name": "Example Controller Pvt Ltd",
  "Website address": "https://example.org",
  "Email for privacy questions and complaints": "privacy@example.org",
  "Postal address": "1 Example Road, Bengaluru 560001, India",
  "Purpose name": "Product updates",
  "What you do with the data": "Send you emails about new features of our app.",
  "Personal data used (separate with commas)": "Email address, Name",
  "How long you keep it": "Until you withdraw consent, then 30 days",
  "Organisations you share personal data with (separate with commas, leave blank if none)": "Example Analytics Ltd",
  "Page where people can withdraw consent": "https://example.org/privacy/withdraw",
  "Page where people can ask to see, correct or erase their data": "https://example.org/privacy/requests",
};

function fillAll(overrides: Record<string, string> = {}) {
  for (const [label, value] of Object.entries({ ...VALUES, ...overrides })) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
}

const create = () => fireEvent.click(screen.getByRole("button", { name: /^(Create|Update) notice$/ }));

const expectedInput = () => {
  const r = validateNoticeInput({
    organisationName: VALUES["Organisation name"],
    websiteUrl: VALUES["Website address"],
    grievanceEmail: "privacy@example.org",
    grievanceAddress: VALUES["Postal address"],
    purposes: [
      {
        name: "Product updates",
        description: "Send you emails about new features of our app.",
        dataItems: ["Email address", "Name"],
        retention: "Until you withdraw consent, then 30 days",
      },
    ],
    thirdParties: ["Example Analytics Ltd"],
    processesChildrenData: false,
    withdrawalUrl: "https://example.org/privacy/withdraw",
    rightsRequestUrl: "https://example.org/privacy/requests",
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe("creating a notice", () => {
  test("an empty submit shows one error per required field, focuses the summary, and shows no notice", () => {
    render(<NoticeForm />);
    create();

    expect(screen.getAllByText(/is required/)).toHaveLength(10);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("10 fields need attention");
    expect(document.activeElement).toBe(alert);
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.getByLabelText("Organisation name").getAttribute("aria-invalid")).toBe("true");
  });

  test("a wrong email and a non-https link are named in their own fields", () => {
    render(<NoticeForm />);
    fillAll({
      "Email for privacy questions and complaints": "nope",
      "Page where people can withdraw consent": "http://example.org/x",
    });
    create();

    expect(screen.getByText("Email for privacy questions and complaints must be an email address")).toBeTruthy();
    expect(screen.getByText(/Page where people can withdraw consent must be an https URL/)).toBeTruthy();
    expect(screen.queryByRole("article")).toBeNull();
  });

  test("a filled form shows the notice, its fingerprint, and the draft marks", async () => {
    render(<NoticeForm />);
    fillAll();
    create();

    const article = await screen.findByRole("article");
    expect(article.textContent).toContain("Privacy notice: Example Controller Pvt Ltd");
    expect(article.textContent).toMatch(/not legal advice/i);
    expect(article.getAttribute("lang")).toBe("en");
    expect(screen.getByText("DRAFT")).toBeTruthy();
    const hash = await noticeSha256(renderNotice(expectedInput(), "en").text);
    expect(await screen.findByText(hash)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("switching to Hindi re-renders the notice with Devanagari text and the pending-review status", async () => {
    render(<NoticeForm />);
    fillAll();
    create();
    await screen.findByRole("article");

    fireEvent.click(screen.getByLabelText("हिन्दी (Hindi), beta"));

    const article = await screen.findByRole("article");
    await waitFor(() => expect(article.getAttribute("lang")).toBe("hi"));
    expect(article.textContent).toContain("हम कौन हैं");
    expect(article.textContent).toContain("Example Controller Pvt Ltd");
    expect(screen.getByText("मसौदा")).toBeTruthy();
    expect(screen.getByText(/pending human review/i)).toBeTruthy();
    const hash = await noticeSha256(renderNotice(expectedInput(), "hi").text);
    expect(await screen.findByText(hash)).toBeTruthy();
  });

  test("markup in an organisation name is shown as text and creates no elements", async () => {
    render(<NoticeForm />);
    fillAll({ "Organisation name": "<b>Bold</b> <img src=x onerror=alert(1)>" });
    create();

    const article = await screen.findByRole("article");
    expect(article.textContent).toContain("<b>Bold</b> <img src=x onerror=alert(1)>");
    expect(article.querySelector("b")).toBeNull();
    expect(article.querySelector("img")).toBeNull();
  });

  test("rights are a real list and each purpose's details are separate paragraphs, so wrapped lines keep their indent", async () => {
    render(<NoticeForm />);
    fillAll();
    create();

    const article = await screen.findByRole("article");
    expect(article.querySelectorAll("ul > li")).toHaveLength(5);
    expect(article.querySelector("ul")?.textContent).not.toContain("- ");
    const details = [...article.querySelectorAll("p")].filter((p) => p.textContent?.startsWith("What we do:"));
    expect(details).toHaveLength(1);
    expect(details[0]?.textContent).toBe("What we do: Send you emails about new features of our app.");
  });

  test("no network request is made while creating a notice", async () => {
    const fetchSpy = jest.fn();
    Object.defineProperty(globalThis, "fetch", { value: fetchSpy, configurable: true, writable: true });
    render(<NoticeForm />);
    fillAll();
    create();
    await screen.findByRole("article");

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("the button says Update after the first notice, and the notice follows the edited values", async () => {
    render(<NoticeForm />);
    fillAll();
    create();
    await screen.findByRole("article");

    fillAll({ "Organisation name": "Renamed Pvt Ltd" });
    expect(screen.getByRole("article").textContent).toContain("Example Controller Pvt Ltd");
    create();
    await waitFor(() => expect(screen.getByRole("article").textContent).toContain("Renamed Pvt Ltd"));
  });
});

describe("children and sharing", () => {
  test("ticking the children box changes the notice, and blank sharing says nothing is shared", async () => {
    render(<NoticeForm />);
    fillAll({
      "Organisations you share personal data with (separate with commas, leave blank if none)": "",
    });
    fireEvent.click(screen.getByLabelText("We process personal data of children under 18"));
    create();

    const article = await screen.findByRole("article");
    expect(article.textContent).toContain("verifiable consent from a parent or lawful guardian");
    expect(article.textContent).toContain("We do not share your personal data with other organisations");
  });
});

describe("purposes", () => {
  test("a purpose can be added and removed, but the last one stays", () => {
    render(<NoticeForm />);
    expect(screen.queryByRole("button", { name: /Remove purpose/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add another purpose" }));
    expect(screen.getAllByLabelText("Purpose name")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /Remove purpose/ })).toHaveLength(2);

    fireEvent.click(screen.getAllByRole("button", { name: /Remove purpose/ })[0] as HTMLElement);
    expect(screen.getAllByLabelText("Purpose name")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Remove purpose/ })).toBeNull();
  });

  test("every purpose appears in the notice, and an error names its position", async () => {
    render(<NoticeForm />);
    fillAll();
    fireEvent.click(screen.getByRole("button", { name: "Add another purpose" }));
    create();
    expect(screen.getByText("Purpose 2: Purpose name is required")).toBeTruthy();

    const names = screen.getAllByLabelText("Purpose name");
    fireEvent.change(names[1] as HTMLElement, { target: { value: "Analytics" } });
    fireEvent.change(screen.getAllByLabelText("What you do with the data")[1] as HTMLElement, { target: { value: "Count visits." } });
    fireEvent.change(screen.getAllByLabelText("Personal data used (separate with commas)")[1] as HTMLElement, { target: { value: "Device type" } });
    fireEvent.change(screen.getAllByLabelText("How long you keep it")[1] as HTMLElement, { target: { value: "12 months" } });
    create();

    const article = await screen.findByRole("article");
    expect(article.textContent).toContain("2. Analytics");
  });
});

describe("copy and download", () => {
  test("Copy writes the notice text to the clipboard and says so", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<NoticeForm />);
    fillAll();
    create();
    await screen.findByRole("article");

    fireEvent.click(screen.getByRole("button", { name: "Copy text" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(renderNotice(expectedInput(), "en").text));
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  test("Download is a link whose file holds exactly the notice text", async () => {
    render(<NoticeForm />);
    fillAll();
    create();
    await screen.findByRole("article");

    const link = screen.getByRole("link", { name: "Download as Markdown" });
    expect(link.getAttribute("download")).toBe("privacy-notice-en.md");
    const href = link.getAttribute("href") ?? "";
    expect(href.startsWith("data:text/markdown;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(href.slice("data:text/markdown;charset=utf-8,".length))).toBe(
      renderNotice(expectedInput(), "en").text,
    );
  });
});
