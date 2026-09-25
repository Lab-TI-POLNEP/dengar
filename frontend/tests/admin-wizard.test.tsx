import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import NewTestWizard from "../app/admin/tests/new/page";

let currentSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => currentSearchParams,
}));

function mockWizardApi(importResult: { ok: boolean; status: number; payload: unknown }) {
  return vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/admin/csrf-token")) {
      return { ok: true, status: 200, json: async () => ({ csrf_token: "test-token" }) };
    }
    if (url.endsWith("/admin/api/tests") || url.endsWith("/admin/api/tests/import")) {
      return {
        ok: importResult.ok,
        status: importResult.status,
        json: async () => importResult.payload,
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

function mockDetailApi(options: {
  detail: { status: number; ok: boolean; payload: unknown };
  patch?: { status: number; ok: boolean; payload: unknown };
}) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fn = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body as string | undefined });
    if (url.endsWith("/admin/csrf-token")) {
      return { ok: true, status: 200, json: async () => ({ csrf_token: "test-token" }) };
    }
    if (method === "GET" && /\/admin\/api\/tests\/\d+$/.test(url)) {
      return {
        ok: options.detail.ok,
        status: options.detail.status,
        json: async () => options.detail.payload,
      };
    }
    if (method === "PATCH" && /\/admin\/api\/tests\/\d+$/.test(url)) {
      return {
        ok: options.patch?.ok ?? true,
        status: options.patch?.status ?? 200,
        json: async () => options.patch?.payload ?? {},
      };
    }
    if (url.endsWith("/admin/api/mos-scales")) {
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    }
    if (url.endsWith("/admin/api/engines")) {
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  return { fn, calls };
}

describe("NewTestWizard", () => {
  beforeEach(() => {
    currentSearchParams = new URLSearchParams();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders four wizard steps and the simplified setup form", () => {
    vi.stubGlobal("fetch", mockWizardApi({ ok: true, status: 201, payload: { id: 7 } }));

    render(<NewTestWizard />);

    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByRole("heading", { name: "Setup" })).toBeInTheDocument();
    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.getByLabelText(/Test name/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Test type/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/SUS playback quota/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/MOS Scale Preset/)).not.toBeInTheDocument();
  });

  it("creates a draft and advances to the audio step", async () => {
    vi.stubGlobal(
      "fetch",
      mockWizardApi({ ok: true, status: 201, payload: { id: 7, name: "Pilot", status: "draft" } })
    );

    render(<NewTestWizard />);
    fireEvent.change(screen.getByLabelText(/Test name/), { target: { value: "Pilot" } });
    fireEvent.click(screen.getByRole("button", { name: /Save and continue/ }));

    await waitFor(() => expect(screen.getByText(/No audio assets yet/)).toBeInTheDocument());
    expect(screen.getByText(/Editing draft #7/)).toBeInTheDocument();
  });

  it("shows server validation errors from the import endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      mockWizardApi({ ok: false, status: 422, payload: { errors: ["name: required"] } })
    );

    render(<NewTestWizard />);
    fireEvent.change(screen.getByLabelText(/Test name/), { target: { value: "Pilot" } });
    fireEvent.click(screen.getByRole("button", { name: /Save and continue/ }));

    await waitFor(() => expect(screen.getByText("name: required")).toBeInTheDocument());
  });

  it("returns to the setup step with Previous", async () => {
    vi.stubGlobal("fetch", mockWizardApi({ ok: true, status: 201, payload: { id: 7 } }));

    render(<NewTestWizard />);
    fireEvent.change(screen.getByLabelText(/Test name/), { target: { value: "Pilot" } });
    fireEvent.click(screen.getByRole("button", { name: /Save and continue/ }));
    await waitFor(() => expect(screen.getByText(/No audio assets yet/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));

    expect(screen.getByLabelText(/Test name/)).toBeInTheDocument();
  });

  it("does not show Save and continue when the audio library is empty", async () => {
    vi.stubGlobal("fetch", mockWizardApi({ ok: true, status: 201, payload: { id: 7, name: "Pilot", status: "draft" } }));

    render(<NewTestWizard />);
    fireEvent.change(screen.getByLabelText(/Test name/), { target: { value: "Pilot" } });
    fireEvent.click(screen.getByRole("button", { name: /Save and continue/ }));

    await waitFor(() => expect(screen.getByText(/No audio assets yet/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Save and continue/ })).not.toBeInTheDocument();
  });

  it("loads an existing draft and pre-fills the setup form", async () => {
    currentSearchParams = new URLSearchParams("id=9");
    const { fn } = mockDetailApi({
      detail: {
        ok: true,
        status: 200,
        payload: {
          status: "draft",
          config: {
            name: "Draft A",
            audio: { sample_a: "sample_a.wav" },
            pages: [{ kind: "consent", title: "Consent" }, { kind: "completion", title: "Done" }],
            mos: { min: 1, max: 5, labels: ["Bad", "Poor", "Fair", "Good", "Excellent"] },
            sus: { quota: 3 },
          },
        },
      },
    });
    vi.stubGlobal("fetch", fn);

    render(<NewTestWizard />);

    await waitFor(() => expect(screen.getByDisplayValue("Draft A")).toBeInTheDocument());
    expect(screen.getByLabelText(/Test type/)).toHaveValue("combined");
    expect(screen.getByText(/Editing draft #9/)).toBeInTheDocument();
  });

  it("saves edits with PATCH and preserves the loaded audio manifest", async () => {
    currentSearchParams = new URLSearchParams("id=9");
    const { fn, calls } = mockDetailApi({
      detail: {
        ok: true,
        status: 200,
        payload: {
          status: "draft",
          config: {
            name: "Draft A",
            audio: { sample_a: "sample_a.wav" },
            pages: [{ kind: "consent", title: "Consent" }, { kind: "completion", title: "Done" }],
            mos: { min: 1, max: 5, labels: ["1", "2", "3", "4", "5"] },
            sus: { quota: 3 },
          },
        },
      },
      patch: { ok: true, status: 200, payload: { id: 9, name: "Draft A renamed", status: "draft" } },
    });
    vi.stubGlobal("fetch", fn);

    render(<NewTestWizard />);
    await waitFor(() => expect(screen.getByDisplayValue("Draft A")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/Test name/), { target: { value: "Draft A renamed" } });
    fireEvent.click(screen.getByRole("button", { name: /Save and continue/ }));

    await waitFor(() => expect(screen.getByText(/No audio assets yet/)).toBeInTheDocument());
    const patchCall = calls.find((call) => call.method === "PATCH");
    expect(patchCall).toBeDefined();
    expect(patchCall?.body).toContain("sample_a");
    expect(patchCall?.body).toContain("Draft A renamed");
  });

  it("selects audio with automatic task assignment and saves to stimuli", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/admin/csrf-token")) {
        return { ok: true, status: 200, json: async () => ({ csrf_token: "test-token" }) };
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
                id: "abcde1234567890abcdef1234567890",
                original_filename: "sample.wav",
                content_type: "audio/wav",
                size_bytes: 1234,
                status: "active",
                engine_id: 11,
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
              { id: 1, name: "Standard MOS", minimum: 1, maximum: 5, labels: ["Bad", "Poor", "Fair", "Good", "Excellent"], prompt: "Rate naturalness:" },
            ],
          }),
        };
      }
      if (url.endsWith("/admin/api/tests/7") && method === "PATCH") {
        return { ok: true, status: 200, json: async () => ({ id: 7, status: "draft" }) };
      }
      if (url.endsWith("/admin/api/engines") && method === "GET") {
        return { ok: true, status: 200, json: async () => ({ items: [{ id: 11, name: "Engine A" }] }) };
      }
      if (url.endsWith("/admin/api/tests/7/stimuli") && method === "PUT") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: [{ neutral_label: "S1", engine_id: 11, audio_ref: "clip-abcde123", kind: "mos" }] }),
        };
      }
      if (url.endsWith("/admin/api/tests/7/demographics") && method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              { key: "normal_hearing", label: "Normal hearing status", field_type: "text", required: false, enabled: true },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    render(<NewTestWizard />);

    fireEvent.change(screen.getByLabelText(/Test name/), { target: { value: "Pilot" } });
    fireEvent.click(screen.getByRole("button", { name: /Save and continue/ }));

    await waitFor(() => expect(screen.getByText(/sample.wav/)).toBeInTheDocument());
    expect(screen.getByText("Engine: Engine A")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox"));
    const presetSelect = screen.queryByLabelText(/MOS Scale Preset/);
    if (presetSelect) {
      fireEvent.change(presetSelect, { target: { value: "1" } });
    }
    fireEvent.click(screen.getByRole("button", { name: /Save and continue/ }));

    await waitFor(() => expect(screen.getByText(/Configure demographic fields/)).toBeInTheDocument());
  });

  it("loads an existing published test and pre-fills the setup form", async () => {
    currentSearchParams = new URLSearchParams("id=9");
    const { fn } = mockDetailApi({
      detail: {
        ok: true,
        status: 200,
        payload: {
          status: "published",
          config: {
            name: "Published A",
            test_type: "combined",
            audio: { sample_a: "sample_a.wav" },
            pages: [{ kind: "consent", title: "Consent" }, { kind: "completion", title: "Done" }],
            mos: { min: 1, max: 5, labels: ["Bad", "Poor", "Fair", "Good", "Excellent"] },
            sus: { quota: 3 },
          },
        },
      },
    });
    vi.stubGlobal("fetch", fn);

    render(<NewTestWizard />);

    await waitFor(() => expect(screen.getByDisplayValue("Published A")).toBeInTheDocument());
    expect(screen.getByLabelText(/Test type/)).toHaveValue("combined");
    expect(screen.getByText(/Editing published test #9/)).toBeInTheDocument();
  });

  it("allows direct navigation via pills when editing a published test", async () => {
    currentSearchParams = new URLSearchParams("id=9");
    const { fn } = mockDetailApi({
      detail: {
        ok: true,
        status: 200,
        payload: {
          status: "published",
          config: {
            name: "Published A",
            test_type: "combined",
            audio: { sample_a: "sample_a.wav" },
            pages: [{ kind: "consent", title: "Consent" }, { kind: "completion", title: "Done" }],
            mos: { min: 1, max: 5, labels: ["Bad", "Poor", "Fair", "Good", "Excellent"] },
            sus: { quota: 3 },
          },
        },
      },
    });
    vi.stubGlobal("fetch", fn);

    render(<NewTestWizard />);
    await waitFor(() => expect(screen.getByDisplayValue("Published A")).toBeInTheDocument());

    const demoPill = screen.getByRole("button", { name: "Demographics" });
    fireEvent.click(demoPill);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Demographics" })).toBeInTheDocument());
  });

  it("allows direct navigation via pills when editing a draft test", async () => {
    currentSearchParams = new URLSearchParams("id=9");
    const { fn } = mockDetailApi({
      detail: {
        ok: true,
        status: 200,
        payload: {
          status: "draft",
          config: {
            name: "Draft A",
            test_type: "mos",
            audio: { sample_a: "sample_a.wav" },
            pages: [{ kind: "consent", title: "Consent" }, { kind: "completion", title: "Done" }],
            mos: { min: 1, max: 5, labels: ["Bad", "Poor", "Fair", "Good", "Excellent"] },
            sus: { quota: 3 },
          },
        },
      },
    });
    vi.stubGlobal("fetch", fn);

    render(<NewTestWizard />);
    await waitFor(() => expect(screen.getByDisplayValue("Draft A")).toBeInTheDocument());

    const demoPill = screen.getByRole("button", { name: "Demographics" });
    expect(demoPill).toBeInTheDocument();
    fireEvent.click(demoPill);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Demographics" })).toBeInTheDocument());
  });

  it("transitions a published test to draft status when a step is saved", async () => {
    currentSearchParams = new URLSearchParams("id=9");
    const { fn, calls } = mockDetailApi({
      detail: {
        ok: true,
        status: 200,
        payload: {
          status: "published",
          config: {
            name: "Published A",
            test_type: "combined",
            audio: { sample_a: "sample_a.wav" },
            pages: [{ kind: "consent", title: "Consent" }, { kind: "completion", title: "Done" }],
            mos: { min: 1, max: 5, labels: ["Bad", "Poor", "Fair", "Good", "Excellent"] },
            sus: { quota: 3 },
          },
        },
      },
      patch: { ok: true, status: 200, payload: { id: 9, name: "Published A renamed", status: "draft" } },
    });
    vi.stubGlobal("fetch", fn);

    render(<NewTestWizard />);
    await waitFor(() => expect(screen.getByDisplayValue("Published A")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/Test name/), { target: { value: "Published A renamed" } });
    fireEvent.click(screen.getByRole("button", { name: /Save and continue/ }));

    await waitFor(() => expect(screen.getByText(/Editing draft #9/)).toBeInTheDocument());
  });

  it("keeps wizard step pills clickable after saving a step when editing a published test", async () => {
    currentSearchParams = new URLSearchParams("id=9");
    const { fn } = mockDetailApi({
      detail: {
        ok: true,
        status: 200,
        payload: {
          status: "published",
          config: {
            name: "Published A",
            test_type: "combined",
            audio: { sample_a: "sample_a.wav" },
            pages: [{ kind: "consent", title: "Consent" }, { kind: "completion", title: "Done" }],
            mos: { min: 1, max: 5, labels: ["Bad", "Poor", "Fair", "Good", "Excellent"] },
            sus: { quota: 3 },
          },
        },
      },
      patch: { ok: true, status: 200, payload: { id: 9, name: "Published A renamed", status: "draft" } },
    });
    vi.stubGlobal("fetch", fn);

    render(<NewTestWizard />);
    await waitFor(() => expect(screen.getByDisplayValue("Published A")).toBeInTheDocument());

    // Click "Save and continue" on the first step (Setup)
    fireEvent.click(screen.getByRole("button", { name: /Save and continue/ }));

    // Verify it transitions and displays "Editing draft #9"
    await waitFor(() => expect(screen.getByText(/Editing draft #9/)).toBeInTheDocument());

    // Verify that the step pills (e.g. Demographics) are still clickable (visible as buttons)
    const demoPill = screen.getByRole("button", { name: "Demographics" });
    expect(demoPill).toBeInTheDocument();

    // Clicking the pill should navigate to the Demographics step
    fireEvent.click(demoPill);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Demographics" })).toBeInTheDocument());
  });

  it("configures test type and creates draft with test_type in YAML", async () => {
    const importCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/admin/csrf-token")) {
          return { ok: true, status: 200, json: async () => ({ csrf_token: "test-token" }) };
        }
        if (url.endsWith("/admin/api/mos-scales")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              items: [
                {
                  id: 42,
                  name: "Quality 1-5 Scale",
                  minimum: 1,
                  maximum: 5,
                  labels: ["Very Bad", "Poor", "Fair", "Good", "Excellent"],
                  prompt: "Rate overall quality:",
                },
              ],
            }),
          };
        }
        if ((url.endsWith("/admin/api/tests") || url.endsWith("/admin/api/tests/import")) && method === "POST") {
          importCalls.push((init?.body as string) || "");
          return { ok: true, status: 201, json: async () => ({ id: 8, name: "SUS Study", status: "draft" }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      })
    );

    render(<NewTestWizard />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Setup" })).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/Test name/), { target: { value: "SUS Study" } });
    fireEvent.change(screen.getByLabelText(/Test type/), { target: { value: "sus" } });

    fireEvent.click(screen.getByRole("button", { name: /Save and continue/ }));

    await waitFor(() => expect(importCalls.length).toBe(1));
    expect(importCalls[0]).toContain("sus:");
    expect(importCalls[0]).toContain("name: \\\"SUS Study\\\"");
  });

  it("blocks saving and displays validation error when no MOS scale preset is selected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/admin/csrf-token")) {
          return { ok: true, status: 200, json: async () => ({ csrf_token: "test-token" }) };
        }
        if (url.endsWith("/admin/api/audio")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              items: [{ id: "abc123450000000000000000", original_filename: "sample.wav", engine_id: 11, status: "active" }],
            }),
          };
        }
        if (url.endsWith("/admin/api/engines")) {
          return { ok: true, status: 200, json: async () => ({ items: [{ id: 11, name: "Engine A" }] }) };
        }
        if (url.endsWith("/admin/api/mos-scales")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              items: [{ id: 1, name: "Standard MOS", minimum: 1, maximum: 5, labels: ["1", "2", "3", "4", "5"], prompt: "Rate:" }],
            }),
          };
        }
        if (url.endsWith("/admin/api/tests") && method === "POST") {
          return { ok: true, status: 201, json: async () => ({ id: 7, name: "MOS Test", status: "draft" }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      })
    );

    render(<NewTestWizard />);
    fireEvent.change(screen.getByLabelText(/Test name/), { target: { value: "MOS Test" } });
    fireEvent.click(screen.getByRole("button", { name: /Save and continue/ }));

    await waitFor(() => expect(screen.getByText("sample.wav")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("checkbox"));

    // Attempt to save with "No preset selected" default
    fireEvent.click(screen.getByRole("button", { name: /Save and continue/ }));

    expect(await screen.findByText("Please select a MOS scale preset.")).toBeInTheDocument();
  });
});
