import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import WizardPage from "../app/admin/tests/new/page";

let currentSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => currentSearchParams,
}));

const audioItems = [
  {
    id: "a".repeat(32),
    original_filename: "voice-a.wav",
    content_type: "audio/wav",
    size_bytes: 2048,
    status: "active",
    engine_id: 1,
  },
  {
    id: "b".repeat(32),
    original_filename: "voice-b.wav",
    content_type: "audio/wav",
    size_bytes: 1024,
    status: "active",
    engine_id: 1,
  },
];

function mockAudioFlowApi(options?: { detailPayload?: unknown }) {
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
      return { ok: true, status: 200, json: async () => ({ items: audioItems }) };
    }
    if (url.endsWith("/admin/api/engines")) {
      return { ok: true, status: 200, json: async () => ({ items: [{ id: 1, name: "Engine A" }] }) };
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
    if (method === "PATCH" && /\/admin\/api\/tests\/\d+$/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ id: 7 }) };
    }
    if (method === "PUT" && /\/admin\/api\/tests\/\d+\/stimuli$/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    }
    if (method === "GET" && /\/admin\/api\/tests\/\d+\/demographics$/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ items: [{ key: "normal_hearing", label: "Normal hearing status", field_type: "text", required: false, enabled: true }] }) };
    }
    if (method === "GET" && /\/admin\/api\/tests\/\d+$/.test(url)) {
      return { ok: true, status: 200, json: async () => options?.detailPayload ?? {} };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  return { fn, calls };
}

describe("NewTestWizard audio step", () => {
  beforeEach(() => {
    currentSearchParams = new URLSearchParams();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists library assets with read-only engine badge after the setup step", async () => {
    const { fn } = mockAudioFlowApi();
    vi.stubGlobal("fetch", fn);

    render(<WizardPage />);
    fireEvent.change(screen.getByLabelText(/Test name/), { target: { value: "Pilot" } });
    fireEvent.click(screen.getByRole("button", { name: /Save and continue/ }));

    await waitFor(() => expect(screen.getByText("voice-a.wav")).toBeInTheDocument());
    expect(screen.getByText("voice-b.wav")).toBeInTheDocument();
    expect(screen.getAllByText("Engine: Engine A")).toHaveLength(2);
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  });

  it("saves the selection and stimuli then advances to demographics", async () => {
    const { fn, calls } = mockAudioFlowApi();
    vi.stubGlobal("fetch", fn);

    render(<WizardPage />);
    fireEvent.change(screen.getByLabelText(/Test name/), { target: { value: "Pilot" } });
    fireEvent.click(screen.getByRole("button", { name: /Save and continue/ }));
    await waitFor(() => expect(screen.getByText("voice-a.wav")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("checkbox", { name: /voice-a\.wav/ }));
    const presetSelect = screen.queryByLabelText(/MOS Scale Preset/);
    if (presetSelect) {
      fireEvent.change(presetSelect, { target: { value: "1" } });
    }
    fireEvent.click(screen.getByRole("button", { name: /Save and continue/ }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Demographics" })).toBeInTheDocument());
    const patchCall = calls.find((call) => call.method === "PATCH");
    expect(patchCall).toBeDefined();
    expect(patchCall?.body).toContain("clip-aaaaaaaa");
    expect(patchCall?.body).toContain("a".repeat(32));

    const stimuliPut = calls.find((call) => call.method === "PUT" && call.url.includes("/stimuli"));
    expect(stimuliPut).toBeDefined();
  });

  it("pre-selects assets stored in the draft configuration", async () => {
    currentSearchParams = new URLSearchParams("id=9");
    const { fn } = mockAudioFlowApi({
      detailPayload: {
        status: "draft",
        config: {
          name: "Draft A",
          test_type: "mos",
          audio: { "clip-bbbbbbbb": "b".repeat(32) },
          pages: [
            { kind: "consent", title: "Consent" },
            { kind: "completion", title: "Done" },
          ],
          mos: { min: 1, max: 5, labels: ["1", "2", "3", "4", "5"] },
        },
      },
    });
    vi.stubGlobal("fetch", fn);

    render(<WizardPage />);
    await waitFor(() => expect(screen.getByDisplayValue("Draft A")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Save and continue/ }));

    await waitFor(() => {
      expect(screen.getByText("voice-b.wav")).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: /voice-b\.wav/ })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: /voice-a\.wav/ })).not.toBeChecked();
    });
  });

  it("does not render engine dropdown in audio selection list", async () => {
    const { fn } = mockAudioFlowApi();
    vi.stubGlobal("fetch", fn);

    render(<WizardPage />);
    fireEvent.change(screen.getByLabelText(/Test name/), { target: { value: "Pilot" } });
    fireEvent.click(screen.getByRole("button", { name: /Save and continue/ }));

    await waitFor(() => expect(screen.getByText("voice-a.wav")).toBeInTheDocument());
    expect(screen.queryByLabelText(/Engine for voice-a\.wav/)).not.toBeInTheDocument();
  });
});

