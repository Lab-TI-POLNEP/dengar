import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import AdminLayout from "../app/admin/layout";

let push = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin",
  useRouter: () => ({ push }),
}));

describe("AdminLayout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    push = vi.fn();
  });

  it("redirects unauthenticated admin users to the sign-in page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));

    render(
      <AdminLayout>
        <div>Protected content</div>
      </AdminLayout>
    );

    await waitFor(() => expect(push).toHaveBeenCalledWith("/admin/signin"));
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
  });
});
