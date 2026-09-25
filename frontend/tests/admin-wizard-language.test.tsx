import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import NewTestWizard from "../app/admin/tests/new/page";

let currentSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => currentSearchParams,
}));

describe("Multilingual Audio Language Selection in Admin Wizard", () => {
  beforeEach(() => {
    currentSearchParams = new URLSearchParams();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders Audio language select dropdown with Indonesian, English, and Chinese options", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/admin/csrf-token")) {
          return { ok: true, status: 200, json: async () => ({ csrf_token: "test-token" }) };
        }
        return { ok: true, status: 200, json: async () => ({ items: [] }) };
      })
    );

    render(<NewTestWizard />);

    const languageSelect = screen.getByLabelText(/Audio language/i) as HTMLSelectElement;
    expect(languageSelect).toBeInTheDocument();
    expect(languageSelect.value).toBe("id"); // default to Indonesian

    const options = Array.from(languageSelect.options).map((opt) => ({
      value: opt.value,
      text: opt.text,
    }));

    expect(options).toEqual([
      { value: "id", text: "Indonesian (Bahasa Indonesia)" },
      { value: "en", text: "English" },
      { value: "zh", text: "Chinese / Mandarin (中文)" },
    ]);
  });

  it("serializes the selected language into the test config YAML when saving setup", async () => {
    let capturedBody: string | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (url.endsWith("/admin/csrf-token")) {
          return { ok: true, status: 200, json: async () => ({ csrf_token: "test-token" }) };
        }
        if ((url.endsWith("/admin/api/tests") || url.endsWith("/admin/api/tests/import")) && method === "POST") {
          capturedBody = init?.body as string;
          return {
            ok: true,
            status: 201,
            json: async () => ({ id: 42, name: "Chinese TTS Pilot", status: "draft" }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ items: [] }) };
      })
    );

    render(<NewTestWizard />);

    fireEvent.change(screen.getByLabelText(/Test name/i), {
      target: { value: "Chinese TTS Pilot" },
    });
    fireEvent.change(screen.getByLabelText(/Audio language/i), {
      target: { value: "zh" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Save and continue/i }));

    await waitFor(() => {
      expect(capturedBody).toBeDefined();
    });

    const parsed = JSON.parse(capturedBody!);
    expect(parsed.yaml).toContain("language: zh");
  });

  it("pre-fills language when loading an existing draft with language configured", async () => {
    currentSearchParams = new URLSearchParams("id=15");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.endsWith("/admin/csrf-token")) {
          return { ok: true, status: 200, json: async () => ({ csrf_token: "test-token" }) };
        }
        if (/\/admin\/api\/tests\/15$/.test(url)) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 15,
              name: "English SUS Study",
              status: "draft",
              config: {
                name: "English SUS Study",
                test_type: "sus",
                language: "en",
                sus: { quota: 2 },
              },
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ items: [] }) };
      })
    );

    render(<NewTestWizard />);

    await waitFor(() => {
      const languageSelect = screen.getByLabelText(/Audio language/i) as HTMLSelectElement;
      expect(languageSelect.value).toBe("en");
    });
  });
});
