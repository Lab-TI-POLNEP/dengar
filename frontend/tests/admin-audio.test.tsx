import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import AudioLibraryPage from "../app/admin/audio/page";

const asset = {
  id: "a".repeat(32),
  original_filename: "sample.wav",
  content_type: "audio/wav",
  size_bytes: 2048,
  sha256: "c".repeat(64),
  status: "active",
  created_at: "2026-08-27T00:00:00",
};

function mockListResponse(items: unknown[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ items }),
  });
}

function mockLibraryApi(initial: unknown[]) {
  let items = [...initial];
  return vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/admin/csrf-token")) {
      return { ok: true, status: 200, json: async () => ({ csrf_token: "test-token" }) };
    }
    if (url.endsWith("/admin/api/audio") && method === "POST") {
      items = [asset, ...items];
      return { ok: true, status: 201, json: async () => asset };
    }
    if (method === "DELETE") {
      items = [];
      return { ok: true, status: 204, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ items }) };
  });
}

describe("AudioLibraryPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders uploaded assets", async () => {
    vi.stubGlobal("fetch", mockListResponse([asset]));

    render(<AudioLibraryPage />);

    await waitFor(() => expect(screen.getByText("sample.wav")).toBeInTheDocument());
    expect(screen.getByText(/2\.0 KB/)).toBeInTheDocument();
    expect(screen.getByText(/audio\/wav/)).toBeInTheDocument();
  });

  it("shows the empty state when no assets exist", async () => {
    vi.stubGlobal("fetch", mockListResponse([]));

    render(<AudioLibraryPage />);

    await waitFor(() =>
      expect(screen.getByText(/No audio assets yet/)).toBeInTheDocument()
    );
  });

  it("renders reference transcription and saves updates with PATCH", async () => {
    const transitAsset = {
      ...asset,
      reference_transcription: "original transcription",
    };
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/admin/csrf-token")) {
        return { ok: true, status: 200, json: async () => ({ csrf_token: "test-token" }) };
      }
      if (url.endsWith("/admin/api/audio") && method === "GET") {
        return { ok: true, status: 200, json: async () => ({ items: [transitAsset] }) };
      }
      if (url.endsWith(`/admin/api/audio/${transitAsset.id}`) && method === "PATCH") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        transitAsset.reference_transcription = body.reference_transcription;
        return { ok: true, status: 200, json: async () => transitAsset };
      }
      return { ok: true, status: 200, json: async () => ({ items: [transitAsset] }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AudioLibraryPage />);

    await waitFor(() => expect(screen.getByText("sample.wav")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    await waitFor(() => expect(screen.getByDisplayValue("original transcription")).toBeInTheDocument());

    const textarea = screen.getByRole("textbox", { name: /Reference transcription/i });
    fireEvent.change(textarea, { target: { value: "updated transcription" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/admin/api/audio/${transitAsset.id}`),
      expect.objectContaining({ method: "PATCH" })
    ));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/admin/api/audio/${transitAsset.id}`),
      expect.objectContaining({
        body: JSON.stringify({ engine_id: null, reference_transcription: "updated transcription" }),
      })
    );
  });

  it("shows an error when an audio stream fails", async () => {
    vi.stubGlobal("fetch", mockListResponse([asset]));

    render(<AudioLibraryPage />);

    await waitFor(() => expect(screen.getByText("sample.wav")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.error(document.querySelector("audio") as HTMLAudioElement);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not play sample.wav. The audio stream failed or is unavailable."
    );
  });

  it("saves selected engine and reference transcription simultaneously", async () => {
    const transitAsset = {
      ...asset,
      engine_id: null,
      reference_transcription: "",
    };
    const engines = [{ id: 42, name: "Engine Alpha" }];
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/admin/csrf-token")) {
        return { ok: true, status: 200, json: async () => ({ csrf_token: "test-token" }) };
      }
      if (url.endsWith("/admin/api/engines") && method === "GET") {
        return { ok: true, status: 200, json: async () => ({ items: engines }) };
      }
      if (url.endsWith("/admin/api/audio") && method === "GET") {
        return { ok: true, status: 200, json: async () => ({ items: [transitAsset] }) };
      }
      if (url.endsWith(`/admin/api/audio/${transitAsset.id}`) && method === "PATCH") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        transitAsset.engine_id = body.engine_id;
        transitAsset.reference_transcription = body.reference_transcription;
        return { ok: true, status: 200, json: async () => transitAsset };
      }
      return { ok: true, status: 200, json: async () => ({ items: [transitAsset] }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AudioLibraryPage />);

    await waitFor(() => expect(screen.getByText("sample.wav")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "View" }));

    await waitFor(() => expect(screen.getByRole("combobox", { name: /Engine for sample\.wav/i })).toBeInTheDocument());
    fireEvent.change(screen.getByRole("combobox", { name: /Engine for sample\.wav/i }), {
      target: { value: "42" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Reference transcription/i }), {
      target: { value: "Kalimat uji semantik" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/admin/api/audio/${transitAsset.id}`),
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ engine_id: 42, reference_transcription: "Kalimat uji semantik" }),
      })
    ));
  });

  it("uploads a file and refreshes the list", async () => {
    vi.stubGlobal("fetch", mockLibraryApi([]));

    render(<AudioLibraryPage />);
    await waitFor(() =>
      expect(screen.getByText(/No audio assets yet/)).toBeInTheDocument()
    );

    const input = screen.getByLabelText(/Audio file/);
    fireEvent.change(input, {
      target: { files: [new File(["RIFF"], "sample.wav", { type: "audio/wav" })] },
    });

    await waitFor(() => expect(screen.getByText("sample.wav")).toBeInTheDocument());
  });

  it("deletes an asset after confirmation", async () => {
    vi.stubGlobal("fetch", mockLibraryApi([asset]));
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));

    render(<AudioLibraryPage />);
    await waitFor(() => expect(screen.getByText("sample.wav")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete audio" }));

    await waitFor(() =>
      expect(screen.getByText(/No audio assets yet/)).toBeInTheDocument()
    );
  });

  it("shows an error and re-enables the button when the upload request fails", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/admin/api/audio") && method === "GET") {
        return { ok: true, status: 200, json: async () => ({ items: [] }) };
      }
      throw new Error("connection refused");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AudioLibraryPage />);
    await waitFor(() =>
      expect(screen.getByText(/No audio assets yet/)).toBeInTheDocument()
    );

    const input = screen.getByLabelText(/Audio file/);
    fireEvent.change(input, {
      target: { files: [new File(["RIFF"], "broken.wav", { type: "audio/wav" })] },
    });

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/connection refused/)
    );
    expect(screen.getByRole("button", { name: "Upload" })).toBeEnabled();
  });

  it("renders modern pagination controls and navigates between pages", async () => {
    const manyAssets = Array.from({ length: 12 }, (_, index) => ({
      ...asset,
      id: `asset-${index + 1}`.padEnd(32, "x"),
      original_filename: `track_${String(index + 1).padStart(2, "0")}.wav`,
    }));

    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/admin/csrf-token")) {
        return { ok: true, status: 200, json: async () => ({ csrf_token: "test-token" }) };
      }
      if (url.endsWith("/admin/api/settings")) {
        return { ok: true, status: 200, json: async () => ({ default_page_size: 5 }) };
      }
      if (url.endsWith("/admin/api/engines")) {
        return { ok: true, status: 200, json: async () => ({ items: [] }) };
      }
      if (url.endsWith("/admin/api/audio")) {
        return { ok: true, status: 200, json: async () => ({ items: manyAssets }) };
      }
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AudioLibraryPage />);

    // First page items should appear
    await waitFor(() => expect(screen.getByText("track_01.wav")).toBeInTheDocument());
    expect(screen.getByText("track_05.wav")).toBeInTheDocument();
    expect(screen.queryByText("track_06.wav")).not.toBeInTheDocument();

    // Pagination controls should be present
    const nav = screen.getByRole("navigation", { name: "Audio asset pages" });
    expect(nav).toBeInTheDocument();
    expect(within(nav).getByText(/assets/)).toBeInTheDocument();

    // Go to next page
    const nextBtn = screen.getByRole("button", { name: "Next page" });
    fireEvent.click(nextBtn);

    // Second page items should appear
    await waitFor(() => expect(screen.getByText("track_06.wav")).toBeInTheDocument());
    expect(screen.queryByText("track_01.wav")).not.toBeInTheDocument();

    // Go to page 3 directly
    const page3Btn = screen.getByRole("button", { name: "Page 3" });
    fireEvent.click(page3Btn);

    await waitFor(() => expect(screen.getByText("track_11.wav")).toBeInTheDocument());
    expect(screen.getByText("track_12.wav")).toBeInTheDocument();
  });
});
