import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import WizardPage from "../app/admin/tests/new/page";

let currentSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => currentSearchParams,
}));

const mockDemographics = [
  { key: "age", label: "Age range", field_type: "text", required: false, enabled: false },
  { key: "gender", label: "Gender", field_type: "text", required: false, enabled: false },
  { key: "native_speaker", label: "Native speaker of Indonesian", field_type: "text", required: false, enabled: false },
  { key: "normal_hearing", label: "Normal hearing status", field_type: "text", required: false, enabled: true },
  { key: "experience", label: "Previous experience with audio/TTS evaluation", field_type: "text", required: false, enabled: false },
];

function mockFullWizardFlowApi() {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fn = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body as string | undefined });

    if (url.endsWith("/admin/csrf-token")) {
      return { ok: true, status: 200, json: async () => ({ csrf_token: "test-token" }) };
    }
    if (url.endsWith("/admin/api/tests") || url.endsWith("/admin/api/tests/import")) {
      return { ok: true, status: 201, json: async () => ({ id: 7, name: "Pilot", status: "draft" }) };
    }
    if (url.endsWith("/admin/api/audio")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            { id: "asset-1", original_filename: "clip1.wav", content_type: "audio/wav", size_bytes: 100, status: "active", engine_id: 1 },
          ],
        }),
      };
    }
    if (url.endsWith("/admin/api/engines")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ id: 1, name: "Test Engine" }],
        }),
      };
    }
    if (url.endsWith("/admin/api/mos-scales")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ id: 1, name: "Standard 1-5", minimum: 1, maximum: 5, labels: ["1", "2", "3", "4", "5"], prompt: "Rate:" }],
        }),
      };
    }
    if (url.endsWith("/admin/api/tests/7/stimuli")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ audio_ref: "clip-asset-1", engine_id: 1, kind: "mos" }],
        }),
      };
    }
    if (url.endsWith("/admin/api/tests/7/demographics")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: mockDemographics,
        }),
      };
    }
    if (method === "PATCH" && /\/admin\/api\/tests\/\d+$/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ id: 7 }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  return { fn, calls };
}

describe("NewTestWizard demographics step", () => {
  beforeEach(() => {
    currentSearchParams = new URLSearchParams();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads and configures demographics step correctly", async () => {
    const { fn, calls } = mockFullWizardFlowApi();
    vi.stubGlobal("fetch", fn);

    render(<WizardPage />);

    // Step 0: Setup
    fireEvent.change(screen.getByLabelText(/Test name/), { target: { value: "Pilot" } });
    fireEvent.click(screen.getByRole("button", { name: /Save and continue/ }));

    // Step 1: Audio
    await waitFor(() => expect(screen.getByText("clip1.wav")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("checkbox", { name: /clip1\.wav/ }));
    const presetSelect = screen.queryByLabelText(/MOS Scale Preset/);
    if (presetSelect) {
      fireEvent.change(presetSelect, { target: { value: "1" } });
    }
    fireEvent.click(screen.getByRole("button", { name: /Save and continue/ }));

    // Step 2: Demographics
    await waitFor(() => expect(screen.getByRole("heading", { name: "Demographics" })).toBeInTheDocument());
    expect(screen.getByText("Select demographic fields")).toBeInTheDocument();
    expect(screen.getByText("Respondent Form Preview")).toBeInTheDocument();

    // Verify age range and normal hearing status cards exist
    expect(await screen.findByText("Age range")).toBeInTheDocument();
    expect(await screen.findByText("Normal hearing status")).toBeInTheDocument();

    // Preview should render normal_hearing as mandatory, not optional
    expect(screen.getByText("Normal hearing status *")).toBeInTheDocument();
    expect(screen.queryByText("Normal hearing status (optional)")).not.toBeInTheDocument();

    // Verify normal_hearing checkbox is checked and disabled
    const normalHearingCheckbox = screen.getByRole("checkbox", { name: /Normal hearing status/ }) as HTMLInputElement;
    expect(normalHearingCheckbox.checked).toBe(true);
    expect(normalHearingCheckbox.disabled).toBe(true);

    // Verify age range checkbox is unchecked and enabled
    const ageCheckbox = screen.getByRole("checkbox", { name: /Age range/ }) as HTMLInputElement;
    expect(ageCheckbox.checked).toBe(false);
    expect(ageCheckbox.disabled).toBe(false);

    // Toggle age range checkbox
    fireEvent.click(ageCheckbox);
    expect(ageCheckbox.checked).toBe(true);

    // Click Save and continue
    fireEvent.click(screen.getByRole("button", { name: /Save and continue/ }));

    // Verify PUT request was made with correct payload
    await waitFor(() => {
      const putCall = calls.find((call) => call.method === "PUT" && call.url.endsWith("/demographics"));
      expect(putCall).toBeDefined();
      expect(JSON.parse(putCall!.body!)).toEqual({ keys: ["age", "normal_hearing"] });
    });

    // Verify it advances to step 3: Review step
    await waitFor(() => expect(screen.getByRole("heading", { name: "Review" })).toBeInTheDocument());
  });
});
