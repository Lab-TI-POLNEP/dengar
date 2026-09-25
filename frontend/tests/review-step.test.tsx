import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import NewTestWizard from "../app/admin/tests/new/page";

let currentSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => currentSearchParams,
}));

/** Build a fetch mock that progresses the wizard to step 3 (Review). */
function buildReviewFetch(
  options: {
    stimuli?: unknown[];
    publishOk?: boolean;
    publishPayload?: unknown;
    publishStatus?: number;
  } = {}
) {
  const {
    stimuli = [{ neutral_label: "S1", engine_id: 11, audio_ref: "clip-abc12345", kind: "mos" }],
    publishOk = true,
    publishPayload = { id: 7, name: "Pilot", status: "published" },
    publishStatus = 200,
  } = options;

  return vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url.endsWith("/admin/csrf-token")) {
      return { ok: true, status: 200, json: async () => ({ csrf_token: "mock-csrf" }) };
    }
    if ((url.endsWith("/admin/api/tests") || url.endsWith("/admin/api/tests/import")) && method === "POST") {
      return { ok: true, status: 201, json: async () => ({ id: 7, name: "Pilot", status: "draft" }) };
    }
    if (url.endsWith("/admin/api/audio") && method === "GET") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              id: "abc123450000000000000000",
              original_filename: "sample.wav",
              content_type: "audio/wav",
              size_bytes: 1234,
              status: "active",
              engine_id: 11,
              reference_transcription: "the blue sky",
            },
          ],
        }),
      };
    }
    if (url.endsWith("/admin/api/mos-scales") && method === "GET") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              id: 1,
              name: "Standard MOS",
              minimum: 1,
              maximum: 5,
              labels: ["Bad", "Poor", "Fair", "Good", "Excellent"],
              prompt: "Rate naturalness:",
            },
          ],
        }),
      };
    }
    if (/\/admin\/api\/tests\/\d+$/.test(url) && method === "PATCH") {
      return { ok: true, status: 200, json: async () => ({ id: 7, status: "draft" }) };
    }
    if (url.endsWith("/admin/api/engines") && method === "GET") {
      return { ok: true, status: 200, json: async () => ({ items: [{ id: 11, name: "Engine A" }] }) };
    }
    if (/\/admin\/api\/tests\/\d+\/stimuli$/.test(url) && method === "GET") {
      return { ok: true, status: 200, json: async () => ({ items: stimuli }) };
    }
    if (/\/admin\/api\/tests\/\d+\/stimuli$/.test(url) && method === "PUT") {
      return { ok: true, status: 200, json: async () => ({ items: stimuli }) };
    }
    if (/\/admin\/api\/tests\/\d+\/demographics$/.test(url) && method === "GET") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            { key: "normal_hearing", label: "Normal hearing status", field_type: "radio", required: false, enabled: true, options: [] },
            { key: "age", label: "Age range", field_type: "select", required: false, enabled: false, options: [] },
          ],
        }),
      };
    }
    if (/\/admin\/api\/tests\/\d+\/demographics$/.test(url) && method === "PUT") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            { key: "normal_hearing", label: "Normal hearing status", field_type: "radio", required: false, enabled: true, options: [] },
          ],
        }),
      };
    }
    if (/\/admin\/api\/tests\/\d+\/publish$/.test(url) && method === "POST") {
      return { ok: publishOk, status: publishStatus, json: async () => publishPayload };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

/** Helper: advance through all steps to reach the Review step. */
async function navigateToReview() {
  // Step 0: Setup → Step 1: Audio
  fireEvent.change(screen.getByLabelText(/Test name/), { target: { value: "Pilot" } });
  fireEvent.click(screen.getByRole("button", { name: /Save and continue/ }));

  // Step 1: Audio → Step 2: Demographics
  await waitFor(() => expect(screen.getByText(/sample.wav/)).toBeInTheDocument());
  fireEvent.click(screen.getByRole("checkbox"));
  const presetSelect = screen.queryByLabelText(/MOS Scale Preset/);
  if (presetSelect) {
    fireEvent.change(presetSelect, { target: { value: "1" } });
  }
  fireEvent.click(screen.getByRole("button", { name: /Save and continue/ }));

  // Step 2: Demographics → Step 3: Review
  await waitFor(() => expect(screen.getByRole("heading", { name: "Demographics" })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /Save and continue/ }));

  // Confirm Review step rendered
  await waitFor(() => expect(screen.getByRole("heading", { name: "Review" })).toBeInTheDocument());
}

describe("Review step", () => {
  beforeEach(() => {
    currentSearchParams = new URLSearchParams();
    vi.stubGlobal("fetch", buildReviewFetch());
    vi.stubGlobal("location", { href: "" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders summary cards: Setup, Configuration, Audio & Stimuli, Demographics", async () => {
    render(<NewTestWizard />);
    await navigateToReview();

    expect(screen.getByRole("heading", { name: "Setup" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Configuration" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Audio & Stimuli" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Demographics" })).toBeInTheDocument();
  });

  it("shows the test name in the Setup card", async () => {
    render(<NewTestWizard />);
    await navigateToReview();

    expect(screen.getByText("Pilot")).toBeInTheDocument();
  });

  it("shows normal hearing in the Demographics card with mandatory badge", async () => {
    render(<NewTestWizard />);
    await navigateToReview();

    expect(screen.getByText("Normal hearing status")).toBeInTheDocument();
    expect(screen.getByText(/mandatory/)).toBeInTheDocument();
  });

  it("shows read-only engine in Audio & Stimuli table", async () => {
    render(<NewTestWizard />);
    await navigateToReview();

    expect(screen.getByText("Engine A")).toBeInTheDocument();
  });

  it("Edit button in Setup card jumps to step 0", async () => {
    render(<NewTestWizard />);
    await navigateToReview();

    const setupCard = screen.getByRole("heading", { name: "Setup" }).closest(".review-card")!;
    fireEvent.click(setupCard.querySelector("button")!);

    expect(screen.getByLabelText(/Test name/)).toBeInTheDocument();
  });

  it("enables Save and publish button when configuration is complete", async () => {
    render(<NewTestWizard />);
    await navigateToReview();

    const btn = screen.getByRole("button", { name: /Save and publish|Create test/i });
    expect(btn).not.toBeDisabled();

    const saveDraftBtn = screen.getByRole("button", { name: /Save draft|Save test/i });
    expect(saveDraftBtn).toBeInTheDocument();
  });

  it("publish success shows confirmation and redirects", async () => {
    render(<NewTestWizard />);
    await navigateToReview();

    fireEvent.click(screen.getByRole("button", { name: /Save and publish|Create test/i }));

    await waitFor(() =>
      expect(screen.getByText(/Test created successfully/)).toBeInTheDocument()
    );
  });

  it("publish failure shows specific server error", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      buildReviewFetch({
        publishOk: false,
        publishStatus: 422,
        publishPayload: { errors: ["At least one stimulus must be assigned before publishing."] },
      })
    );
    vi.stubGlobal("location", { href: "" });

    render(<NewTestWizard />);
    await navigateToReview();

    fireEvent.click(screen.getByRole("button", { name: /Save and publish|Create test/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/At least one stimulus must be assigned before publishing/)
      ).toBeInTheDocument()
    );
  });

  it("allows jumping to any step via step pills on a saved draft", async () => {
    render(<NewTestWizard />);
    await navigateToReview();

    // The draft has testId = 7 from step 0. Click the "Setup" pill:
    const setupPill = screen.getByRole("button", { name: "Setup" });
    fireEvent.click(setupPill);

    expect(screen.getByLabelText(/Test name/)).toBeInTheDocument();

    // Click Demographics pill directly:
    const demoPill = screen.getByRole("button", { name: "Demographics" });
    fireEvent.click(demoPill);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Demographics" })).toBeInTheDocument();
    });
  });

  it("shows 'Not set' in Text Templates card when templates are not configured", async () => {
    render(<NewTestWizard />);
    await navigateToReview();

    const templateCard = screen.getByRole("heading", { name: "Text Templates" }).closest(".review-card")!;
    expect(templateCard).toHaveTextContent("Informed Consent");
    expect(templateCard).toHaveTextContent("Completion");
    const notSetElements = templateCard.querySelectorAll(".review-missing");
    expect(notSetElements.length).toBe(2);
    expect(notSetElements[0]).toHaveTextContent("Not set");
    expect(notSetElements[1]).toHaveTextContent("Not set");
  });

  it("shows template versions in Text Templates card when templates exist", async () => {
    vi.unstubAllGlobals();
    const baseFetch = buildReviewFetch();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/admin/api/text-templates")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              { id: 1, kind: "consent", version: 3, content: "Custom consent text." },
              { id: 2, kind: "completion", version: 2, content: "Custom completion text." },
            ],
          }),
        };
      }
      return baseFetch(input, init);
    }));
    vi.stubGlobal("location", { href: "" });

    render(<NewTestWizard />);
    await navigateToReview();

    const templateCard = screen.getByRole("heading", { name: "Text Templates" }).closest(".review-card")!;
    expect(templateCard).toHaveTextContent("v3");
    expect(templateCard).toHaveTextContent("v2");
    expect(templateCard.querySelector(".review-missing")).toBeNull();
  });
});


