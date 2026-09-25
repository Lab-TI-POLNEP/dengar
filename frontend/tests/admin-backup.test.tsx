import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import BackupPage from "../app/admin/backup/page";

const backup = {
  filename: "dengar-backup-20260831T000000Z-ab12cd34.zip",
  size_bytes: 2048,
  created_at: "2026-08-31T00:00:00+00:00",
};

describe("BackupPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders existing backups and downloads the selected archive", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/admin/api/backups")) {
        return { ok: true, status: 200, json: async () => ({ items: [backup] }) };
      }
      return { ok: true, status: 200, blob: async () => new Blob(["backup"]) };
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() });

    render(<BackupPage />);

    await waitFor(() => expect(screen.getByText(backup.filename)).toBeInTheDocument());
    expect(screen.getByText(/2\.0 KB/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/admin/api/backups/${encodeURIComponent(backup.filename)}`),
      expect.objectContaining({ credentials: "include" }),
    ));
  });

  it("shows the empty state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [] }),
    }));

    render(<BackupPage />);

    await waitFor(() => expect(screen.getByText(/No backups have been created yet/)).toBeInTheDocument());
  });

  it("does not restore when confirmation is cancelled", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [backup] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => false));

    render(<BackupPage />);

    await waitFor(() => expect(screen.getByText(backup.filename)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    const backupCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes("/admin/api/backups"));
    expect(backupCalls).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/restore"), expect.anything());
  });

  it("restores a confirmed archive and reports the recovery backup", async () => {
    const recovery = "dengar-backup-20260831T000001Z-ef567890.zip";
    let listCalls = 0;
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/admin/api/backups")) {
        listCalls += 1;
        return { ok: true, status: 200, json: async () => ({ items: listCalls === 1 ? [backup] : [backup, { ...backup, filename: recovery }] }) };
      }
      if (url.endsWith("/admin/csrf-token")) {
        return { ok: true, status: 200, json: async () => ({ csrf_token: "csrf-test" }) };
      }
      return { ok: true, status: 200, json: async () => ({ restored_filename: backup.filename, recovery_filename: recovery }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));

    render(<BackupPage />);
    await waitFor(() => expect(screen.getByText(backup.filename)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(recovery));
    const restoreCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/restore"));
    expect(restoreCall).toBeDefined();
    expect(restoreCall?.[0]).toContain(encodeURIComponent(backup.filename));
    expect(restoreCall?.[1]).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: { "X-CSRF-Token": "csrf-test", "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    expect(listCalls).toBe(2);
    await waitFor(() => expect(screen.getAllByText(recovery, { exact: false })).toHaveLength(2));
  });

  it("does not delete when confirmation is cancelled", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [backup] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => false));

    render(<BackupPage />);

    await waitFor(() => expect(screen.getByText(backup.filename)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const backupCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes("/admin/api/backups"));
    expect(backupCalls).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining(`/admin/api/backups/${encodeURIComponent(backup.filename)}`),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("deletes a confirmed backup archive with CSRF protection and refreshes list", async () => {
    let listCalls = 0;
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/admin/api/backups")) {
        listCalls += 1;
        return { ok: true, status: 200, json: async () => ({ items: listCalls === 1 ? [backup] : [] }) };
      }
      if (url.endsWith("/admin/csrf-token")) {
        return { ok: true, status: 200, json: async () => ({ csrf_token: "csrf-test" }) };
      }
      if (init?.method === "DELETE") {
        return { ok: true, status: 204, text: async () => "" };
      }
      return { ok: false, status: 404 };
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));

    render(<BackupPage />);

    await waitFor(() => expect(screen.getByText(backup.filename)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(`Backup ${backup.filename} was deleted.`));
    const deleteCall = fetchMock.mock.calls.find(([input, init]) => init?.method === "DELETE");
    expect(deleteCall).toBeDefined();
    expect(deleteCall?.[0]).toContain(encodeURIComponent(backup.filename));
    expect(deleteCall?.[1]).toMatchObject({
      method: "DELETE",
      credentials: "include",
      headers: { "X-CSRF-Token": "csrf-test" },
    });
    expect(listCalls).toBe(2);
    await waitFor(() => expect(screen.getByText(/No backups have been created yet/)).toBeInTheDocument());
  });

  it("creates a backup without triggering automatic file download", async () => {
    const createdBackup = {
      filename: "dengar-backup-20260901T120000Z-99887766.zip",
      size_bytes: 4096,
      created_at: "2026-09-01T12:00:00+00:00",
    };
    let listCalls = 0;
    const createObjectURLMock = vi.fn(() => "blob:test");
    vi.stubGlobal("URL", { ...URL, createObjectURL: createObjectURLMock, revokeObjectURL: vi.fn() });

    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/admin/api/backups")) {
        if (init?.method === "POST") {
          return {
            ok: true,
            status: 200,
            headers: new Headers({
              "Content-Disposition": `attachment; filename="${createdBackup.filename}"`,
            }),
            blob: async () => new Blob(["new backup"]),
          };
        }
        listCalls += 1;
        return { ok: true, status: 200, json: async () => ({ items: listCalls === 1 ? [] : [createdBackup] }) };
      }
      if (url.endsWith("/admin/csrf-token")) {
        return { ok: true, status: 200, json: async () => ({ csrf_token: "csrf-test" }) };
      }
      return { ok: false, status: 404 };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<BackupPage />);

    await waitFor(() => expect(screen.getByText(/No backups have been created yet/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /\+ Create your first backup/i }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(`Created backup ${createdBackup.filename}.`));
    expect(createObjectURLMock).not.toHaveBeenCalled();
    expect(listCalls).toBe(2);
    await waitFor(() => expect(screen.getByText(createdBackup.filename)).toBeInTheDocument());
  });
});
