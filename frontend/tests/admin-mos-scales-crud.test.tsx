import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import MOSScalesPage from "../app/admin/master-data/mos-scales/page";

const mockScales = [
  {
    id: 1,
    name: "Standard 5-Point MOS",
    minimum: 1,
    maximum: 5,
    labels: ["Bad", "Poor", "Fair", "Good", "Excellent"],
    prompt: "Rate the naturalness of the speech on a scale from 1 to 5.",
  },
  {
    id: 2,
    name: "3-Point Fast Scale",
    minimum: 1,
    maximum: 3,
    labels: ["Bad", "Acceptable", "Good"],
    prompt: "Rate intelligibility:",
  },
];

describe("MOSScalesPage Inline CRUD UI", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (url.endsWith("/admin/csrf-token")) {
          return { ok: true, status: 200, json: async () => ({ csrf_token: "mock-csrf" }) };
        }
        if (url.endsWith("/admin/api/mos-scales") && method === "GET") {
          return { ok: true, status: 200, json: async () => ({ items: mockScales }) };
        }
        if (url.endsWith("/admin/api/mos-scales") && method === "POST") {
          const body = JSON.parse((init?.body as string) || "{}");
          return {
            ok: true,
            status: 201,
            json: async () => ({ id: 3, ...body }),
          };
        }
        if (url.includes("/admin/api/mos-scales/1") && method === "PUT") {
          const body = JSON.parse((init?.body as string) || "{}");
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: 1, ...body }),
          };
        }
        if (url.includes("/admin/api/mos-scales/1") && method === "DELETE") {
          return {
            ok: false,
            status: 409,
            json: async () => ({ error: "record is referenced by a test" }),
          };
        }
        if (url.includes("/admin/api/mos-scales/2") && method === "DELETE") {
          return { ok: true, status: 204, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders loaded MOS scales list with labels and prompt", async () => {
    render(<MOSScalesPage />);
    await waitFor(() => {
      expect(screen.getByText("Standard 5-Point MOS")).toBeInTheDocument();
      expect(screen.getByText("3-Point Fast Scale")).toBeInTheDocument();
      expect(screen.getByText(/Rate intelligibility:/i)).toBeInTheDocument();
      expect(screen.getByText("1 to 5 (5 pts)")).toBeInTheDocument();
    });
  });

  it("opens add form and submits a new scale preset", async () => {
    render(<MOSScalesPage />);
    await waitFor(() => {
      expect(screen.getByText("Standard 5-Point MOS")).toBeInTheDocument();
    });

    const addBtn = screen.getByRole("button", { name: /\+ Add scale preset/i });
    fireEvent.click(addBtn);

    expect(screen.getByRole("heading", { name: "Add new scale preset" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Scale Name/i), {
      target: { value: "New 5-Point MOS" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Create Preset$/i }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/admin/api/mos-scales"),
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  it("loads a preset into inline edit mode directly on the row and updates it", async () => {
    render(<MOSScalesPage />);
    await waitFor(() => {
      expect(screen.getByText("Standard 5-Point MOS")).toBeInTheDocument();
    });

    const editButtons = screen.getAllByRole("button", { name: /^Edit$/i });
    fireEvent.click(editButtons[0]);

    expect(screen.getByRole("heading", { name: "Edit scale preset: Standard 5-Point MOS" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Scale Name/i)).toHaveValue("Standard 5-Point MOS");

    fireEvent.change(screen.getByLabelText(/Scale Name/i), {
      target: { value: "Standard 5-Point MOS Updated" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Save Changes$/i }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/admin/api/mos-scales/1"),
        expect.objectContaining({ method: "PUT" })
      );
    });
  });

  it("displays conflict error when deleting a referenced scale preset", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<MOSScalesPage />);
    await waitFor(() => {
      expect(screen.getByText("Standard 5-Point MOS")).toBeInTheDocument();
    });

    const deleteButtons = screen.getAllByRole("button", { name: /^Delete$/i });
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        /referenced by one or more tests/i
      );
    });
  });

  it("successfully deletes an unreferenced scale preset", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<MOSScalesPage />);
    await waitFor(() => {
      expect(screen.getByText("3-Point Fast Scale")).toBeInTheDocument();
    });

    const deleteButtons = screen.getAllByRole("button", { name: /^Delete$/i });
    fireEvent.click(deleteButtons[1]);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/admin/api/mos-scales/2"),
        expect.objectContaining({ method: "DELETE" })
      );
    });
  });
});
