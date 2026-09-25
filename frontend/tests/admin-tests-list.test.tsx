import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import TestsPage from "../app/admin/tests/page";

function mockTestsApi(items: Array<{ id: number; name: string; version: number; status: string }>) {
  return vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/admin/csrf-token")) {
      return { ok: true, status: 200, json: async () => ({ csrf_token: "test-token" }) };
    }
    if (method === "DELETE" && /\/admin\/api\/tests\/\d+$/.test(url)) {
      return { ok: true, status: 204, json: async () => ({}) };
    }
    if (url.endsWith("/admin/api/tests") && method === "GET") {
      return { ok: true, status: 200, json: async () => ({ items }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

describe("TestsPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the primary New test action and scan-friendly status", async () => {
    vi.stubGlobal(
      "fetch",
      mockTestsApi([
        { id: 1, name: "Draft A", version: 1, status: "draft" },
        { id: 2, name: "Published B", version: 2, status: "published" },
      ])
    );

    render(<TestsPage />);

    await waitFor(() => expect(screen.getByText("Draft A")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /New test/ })).toHaveAttribute("href", "/admin/tests/new");
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("Published")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue editing" })).toHaveAttribute(
      "href",
      "/admin/tests/new?id=1"
    );
    expect(screen.getByRole("link", { name: "Edit published" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unpublish" })).toBeInTheDocument();
  });

  it("renders a guided empty state with a create action", async () => {
    vi.stubGlobal("fetch", mockTestsApi([]));

    render(<TestsPage />);

    await waitFor(() => expect(screen.getByText("Create your first test")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Create a test" })).toHaveAttribute(
      "href",
      "/admin/tests/new"
    );
  });

  it("deletes a draft test after prompt confirmation", async () => {
    const fetchMock = mockTestsApi([{ id: 1, name: "Draft A", version: 1, status: "draft" }]);
    vi.stubGlobal("fetch", fetchMock);
    
    const confirmMock = vi.fn().mockReturnValue(true);
    Object.defineProperty(window, "confirm", { value: confirmMock, writable: true });

    render(<TestsPage />);
    await waitFor(() => expect(screen.getByText("Draft A")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(confirmMock).toHaveBeenCalledWith('Delete draft "Draft A"? This cannot be undone.');
    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(call => call[1]?.method === "DELETE");
      expect(deleteCall).toBeDefined();
      expect(deleteCall![0]).toContain("/admin/api/tests/1");
    });
  });

  it("deletes a published test after prompt confirmation", async () => {
    const fetchMock = mockTestsApi([{ id: 2, name: "Published B", version: 2, status: "published" }]);
    vi.stubGlobal("fetch", fetchMock);
    
    const confirmMock = vi.fn().mockReturnValue(true);
    Object.defineProperty(window, "confirm", { value: confirmMock, writable: true });

    render(<TestsPage />);
    await waitFor(() => expect(screen.getByText("Published B")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(confirmMock).toHaveBeenCalledWith('Delete published test "Published B"? This cannot be undone.');
    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(call => call[1]?.method === "DELETE");
      expect(deleteCall).toBeDefined();
      expect(deleteCall![0]).toContain("/admin/api/tests/2");
    });
  });

  it("publishes a draft test when Publish is clicked", async () => {
    const fetchMock = mockTestsApi([{ id: 1, name: "Draft A", version: 1, status: "draft" }]);
    vi.stubGlobal("fetch", fetchMock);

    render(<TestsPage />);
    await waitFor(() => expect(screen.getByText("Draft A")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() => {
      const publishCall = fetchMock.mock.calls.find(call => call[1]?.method === "POST" && String(call[0]).endsWith("/publish"));
      expect(publishCall).toBeDefined();
      expect(publishCall![0]).toContain("/admin/api/tests/1/publish");
    });
  });

  it("unpublishes a published test when Unpublish is clicked", async () => {
    const fetchMock = mockTestsApi([{ id: 2, name: "Published B", version: 2, status: "published" }]);
    vi.stubGlobal("fetch", fetchMock);

    render(<TestsPage />);
    await waitFor(() => expect(screen.getByText("Published B")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));

    await waitFor(() => {
      const unpublishCall = fetchMock.mock.calls.find(call => call[1]?.method === "POST" && String(call[0]).endsWith("/unpublish"));
      expect(unpublishCall).toBeDefined();
      expect(unpublishCall![0]).toContain("/admin/api/tests/2/unpublish");
    });
  });
});
