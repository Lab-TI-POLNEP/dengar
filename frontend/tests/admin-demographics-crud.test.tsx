import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DemographicFieldsPage from "../app/admin/master-data/demographic-fields/page";

const mockFields = [
  { id: 1, key: "age", label: "Age range", field_type: "select", required: false, options: ["18-25", "26-35"] },
  { id: 2, key: "normal_hearing", label: "Normal hearing status", field_type: "radio", required: true, options: ["Yes", "No"] },
  { id: 3, key: "education", label: "Education", field_type: "text", required: false },
];

describe("DemographicFieldsPage Inline CRUD UI", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (url.endsWith("/admin/csrf-token")) {
          return { ok: true, status: 200, json: async () => ({ csrf_token: "mock-csrf" }) };
        }
        if (url.endsWith("/admin/api/demographic-fields") && method === "GET") {
          return { ok: true, status: 200, json: async () => ({ items: mockFields }) };
        }
        if (url.endsWith("/admin/api/demographic-fields") && method === "POST") {
          return {
            ok: true,
            status: 201,
            json: async () => ({ id: 4, key: "department", label: "Department", field_type: "text", required: false }),
          };
        }
        if (url.includes("/admin/api/demographic-fields/1") && method === "PUT") {
          const body = JSON.parse((init?.body as string) || "{}");
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: 1, ...body }),
          };
        }
        if (url.includes("/admin/api/demographic-fields/3") && method === "PUT") {
          const body = JSON.parse((init?.body as string) || "{}");
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: 3, ...body }),
          };
        }
        if (url.includes("/admin/api/demographic-fields/3") && method === "DELETE") {
          return {
            ok: true,
            status: 204,
            json: async () => ({}),
          };
        }
        if (url.includes("/admin/api/demographic-fields/2") && method === "DELETE") {
          return {
            ok: false,
            status: 400,
            json: async () => ({ error: "Mandatory demographic field 'normal_hearing' cannot be deleted" }),
          };
        }
        if (url.includes("/admin/api/demographic-fields/1") && method === "DELETE") {
          return {
            ok: false,
            status: 400,
            json: async () => ({ error: "Predefined demographic field 'age' cannot be deleted" }),
          };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders loaded demographic fields with Predefined and Mandatory badges", async () => {
    render(<DemographicFieldsPage />);
    await waitFor(() => {
      expect(screen.getByText("Age range")).toBeInTheDocument();
      expect(screen.getByText("Normal hearing status")).toBeInTheDocument();
      expect(screen.getByText("Education")).toBeInTheDocument();
      expect(screen.getAllByText("Predefined").length).toBe(2);
      expect(screen.getByText("Mandatory")).toBeInTheDocument();
    });
  });

  it("opens add form and submits a new record", async () => {
    render(<DemographicFieldsPage />);
    await waitFor(() => {
      expect(screen.getByText("Age range")).toBeInTheDocument();
    });

    const addBtn = screen.getByRole("button", { name: /\+ Add field/i });
    fireEvent.click(addBtn);

    expect(screen.getByRole("heading", { name: "Add new demographic field" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Name \(Label\)/i), {
      target: { value: "Department" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Create Field$/i }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/admin/api/demographic-fields"),
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  it("allows editing label and required by default for predefined fields while keeping key disabled", async () => {
    render(<DemographicFieldsPage />);
    await waitFor(() => {
      expect(screen.getByText("Age range")).toBeInTheDocument();
    });

    // Click Edit on Age range (id 1)
    const editButtons = screen.getAllByRole("button", { name: /^Edit$/i });
    fireEvent.click(editButtons[0]);

    expect(screen.getByRole("heading", { name: "Edit field: Age range" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Name \(Label\)/i)).not.toBeDisabled();
    expect(screen.getByLabelText(/Key/i)).toBeDisabled();
    expect(screen.getByLabelText(/Required by default/i)).not.toBeDisabled();

    // Edit label and check required
    fireEvent.change(screen.getByLabelText(/Name \(Label\)/i), {
      target: { value: "Age Group" },
    });
    fireEvent.click(screen.getByLabelText(/Required by default/i));

    // Save changes
    fireEvent.click(screen.getByRole("button", { name: /^Save Changes$/i }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/admin/api/demographic-fields/1"),
        expect.objectContaining({
          method: "PUT",
          body: expect.stringContaining('"label":"Age Group"'),
        })
      );
    });
  });

  it("closes inline edit mode when Close button is clicked", async () => {
    render(<DemographicFieldsPage />);
    await waitFor(() => {
      expect(screen.getByText("Education")).toBeInTheDocument();
    });

    const editButtons = screen.getAllByRole("button", { name: /^Edit$/i });
    fireEvent.click(editButtons[2]);

    expect(screen.getByRole("heading", { name: "Edit field: Education" })).toBeInTheDocument();

    const closeBtn = screen.getByRole("button", { name: /^Close$/i });
    fireEvent.click(closeBtn);

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Edit field: Education" })).not.toBeInTheDocument();
    });
  });

  it("omits delete button on predefined fields and allows deleting custom fields", async () => {
    render(<DemographicFieldsPage />);
    await waitFor(() => {
      expect(screen.getByText("Normal hearing status")).toBeInTheDocument();
    });

    // Only custom field (Education) has a Delete button
    const deleteButtons = screen.getAllByRole("button", { name: /^Delete$/i });
    expect(deleteButtons.length).toBe(1);
  });

  it("disables required checkbox and forces it checked for mandatory normal_hearing field", async () => {
    render(<DemographicFieldsPage />);
    await waitFor(() => {
      expect(screen.getByText("Normal hearing status")).toBeInTheDocument();
    });

    const editButtons = screen.getAllByRole("button", { name: /^Edit$/i });
    // Click Edit on Normal hearing status (id 2)
    fireEvent.click(editButtons[1]);

    const reqCheckbox = screen.getByLabelText(/Required \(mandatory field\)/i);
    expect(reqCheckbox).toBeChecked();
    expect(reqCheckbox).toBeDisabled();
  });
});
