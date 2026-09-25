import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import TextTemplatesPage from "../app/admin/master-data/text-templates/page";

const mockTemplates = [
  {
    id: 1,
    kind: "consent",
    version: 1,
    content: "Please read this consent agreement carefully.",
  },
  {
    id: 2,
    kind: "completion",
    version: 1,
    content: "Thank you for participating in our speech study.",
  },
];

describe("TextTemplatesPage Inline CRUD UI", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (url.endsWith("/admin/csrf-token")) {
          return { ok: true, status: 200, json: async () => ({ csrf_token: "mock-csrf" }) };
        }
        if (url.endsWith("/admin/api/text-templates") && method === "GET") {
          return { ok: true, status: 200, json: async () => ({ items: mockTemplates }) };
        }
        if (url.endsWith("/admin/api/text-templates") && method === "POST") {
          const body = JSON.parse((init?.body as string) || "{}");
          return {
            ok: true,
            status: 201,
            json: async () => ({ id: 3, ...body, version: body.version ?? 1 }),
          };
        }
        if (url.includes("/admin/api/text-templates/1") && method === "PUT") {
          const body = JSON.parse((init?.body as string) || "{}");
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: 1, ...body }),
          };
        }
        if (url.includes("/admin/api/text-templates/2") && method === "DELETE") {
          return {
            ok: true,
            status: 204,
            json: async () => ({}),
          };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders loaded text templates with kinds and versions", async () => {
    render(<TextTemplatesPage />);

    await waitFor(() => {
      expect(screen.getByText("Text Templates")).toBeInTheDocument();
      expect(screen.getByText("consent")).toBeInTheDocument();
      expect(screen.getByText("completion")).toBeInTheDocument();
      expect(screen.getByText("Please read this consent agreement carefully.")).toBeInTheDocument();
      expect(screen.getByText("Thank you for participating in our speech study.")).toBeInTheDocument();
    });
  });

  it("opens add form and submits a new text template", async () => {
    render(<TextTemplatesPage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /\+?\s*Add template/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /\+?\s*Add template/i }));

    expect(screen.getByText("Add new text template")).toBeInTheDocument();

    const textarea = screen.getByPlaceholderText("Enter template text (e.g. informed consent statement or study debrief message)...");
    fireEvent.change(textarea, { target: { value: "Headphones are required for this listening test." } });

    const submitBtn = screen.getByRole("button", { name: "Create Template" });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/admin/api/text-templates"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            kind: "consent",
            content: "Headphones are required for this listening test.",
          }),
        })
      );
    });
  });

  it("triggers inline edit mode directly on the row and saves changes", async () => {
    render(<TextTemplatesPage />);

    await waitFor(() => {
      expect(screen.getByText("Please read this consent agreement carefully.")).toBeInTheDocument();
    });

    const editBtns = screen.getAllByRole("button", { name: "Edit" });
    fireEvent.click(editBtns[0]);

    expect(screen.getByText("Editing Template #1")).toBeInTheDocument();

    const textarea = screen.getByPlaceholderText("Template content");
    fireEvent.change(textarea, { target: { value: "Updated consent agreement text." } });

    const saveBtn = screen.getByRole("button", { name: "Save Changes" });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/admin/api/text-templates/1"),
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            kind: "consent",
            version: 1,
            content: "Updated consent agreement text.",
          }),
        })
      );
    });
  });

  it("successfully deletes a template when confirmed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<TextTemplatesPage />);

    await waitFor(() => {
      expect(screen.getByText("Thank you for participating in our speech study.")).toBeInTheDocument();
    });

    const deleteBtns = screen.getAllByRole("button", { name: "Delete" });
    fireEvent.click(deleteBtns[1]);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/admin/api/text-templates/2"),
        expect.objectContaining({
          method: "DELETE",
        })
      );
    });
  });
});
