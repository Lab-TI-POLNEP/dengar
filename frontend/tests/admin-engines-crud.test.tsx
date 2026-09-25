import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import EnginesPage from "../app/admin/master-data/engines/page";

const mockEngines = [
  {
    id: 1,
    name: "ElevenLabs",
    description: "Neural voice generator",
  },
  {
    id: 2,
    name: "Google TTS",
    description: "Cloud text-to-speech",
  },
];

describe("EnginesPage Inline CRUD UI", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (url.endsWith("/admin/csrf-token")) {
          return { ok: true, status: 200, json: async () => ({ csrf_token: "mock-csrf" }) };
        }
        if (url.endsWith("/admin/api/engines") && method === "GET") {
          return { ok: true, status: 200, json: async () => ({ items: mockEngines }) };
        }
        if (url.endsWith("/admin/api/engines") && method === "POST") {
          const body = JSON.parse((init?.body as string) || "{}");
          return {
            ok: true,
            status: 201,
            json: async () => ({ id: 3, ...body }),
          };
        }
        if (url.includes("/admin/api/engines/1") && method === "PUT") {
          const body = JSON.parse((init?.body as string) || "{}");
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: 1, ...body }),
          };
        }
        if (url.includes("/admin/api/engines/1") && method === "DELETE") {
          return {
            ok: false,
            status: 409,
            json: async () => ({ error: "record is referenced by a test" }),
          };
        }
        if (url.includes("/admin/api/engines/2") && method === "DELETE") {
          return { ok: true, status: 204, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders loaded engines list with names and descriptions", async () => {
    render(<EnginesPage />);
    await waitFor(() => {
      expect(screen.getByText("ElevenLabs")).toBeInTheDocument();
      expect(screen.getByText("Neural voice generator")).toBeInTheDocument();
      expect(screen.getByText("Google TTS")).toBeInTheDocument();
      expect(screen.getByText("Cloud text-to-speech")).toBeInTheDocument();
    });
  });

  it("opens add form and submits a new engine record", async () => {
    render(<EnginesPage />);
    await waitFor(() => {
      expect(screen.getByText("ElevenLabs")).toBeInTheDocument();
    });

    const addBtn = screen.getByRole("button", { name: /\+ Add engine/i });
    fireEvent.click(addBtn);

    expect(screen.getByRole("heading", { name: "Add new engine" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Engine Name/i), {
      target: { value: "XTTS-v2" },
    });
    fireEvent.change(screen.getByLabelText(/Description/i), {
      target: { value: "Coqui voice cloning model" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Create Engine$/i }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/admin/api/engines"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "XTTS-v2", description: "Coqui voice cloning model" }),
        })
      );
    });
  });

  it("triggers inline edit mode directly on the row and updates/renames the engine", async () => {
    render(<EnginesPage />);
    await waitFor(() => {
      expect(screen.getByText("ElevenLabs")).toBeInTheDocument();
    });

    const editButtons = screen.getAllByRole("button", { name: /^Edit$/i });
    fireEvent.click(editButtons[0]);

    expect(screen.getByRole("heading", { name: "Editing Engine #1" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Engine Name/i)).toHaveValue("ElevenLabs");

    fireEvent.change(screen.getByLabelText(/Engine Name/i), {
      target: { value: "ElevenLabs Multilingual v2" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Save Changes$/i }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/admin/api/engines/1"),
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ name: "ElevenLabs Multilingual v2", description: "Neural voice generator" }),
        })
      );
    });
  });

  it("displays conflict error when deleting an engine referenced by a test", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<EnginesPage />);
    await waitFor(() => {
      expect(screen.getByText("ElevenLabs")).toBeInTheDocument();
    });

    const deleteButtons = screen.getAllByRole("button", { name: /^Delete$/i });
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        /referenced by one or more tests/i
      );
    });
  });

  it("successfully deletes an unreferenced engine", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<EnginesPage />);
    await waitFor(() => {
      expect(screen.getByText("Google TTS")).toBeInTheDocument();
    });

    const deleteButtons = screen.getAllByRole("button", { name: /^Delete$/i });
    fireEvent.click(deleteButtons[1]);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/admin/api/engines/2"),
        expect.objectContaining({ method: "DELETE" })
      );
    });
  });
});
