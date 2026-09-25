"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { adminRequest, getCsrfToken } from "@/lib/admin-api";
import { Pagination } from "@/components/Pagination";

type BackupItem = {
  filename: string;
  size_bytes: number;
  created_at: string;
};

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatDateTime(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function describeFailure(cause: unknown): string {
  return cause instanceof Error ? cause.message : "unexpected network error";
}

export default function BackupPage() {
  const [items, setItems] = useState<BackupItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [defaultPageSize, setDefaultPageSize] = useState<number | null>(null);
  const [pageSize, setPageSize] = useState<number | null>(null);
  const [page, setPage] = useState(1);

  const effectivePageSize = pageSize ?? defaultPageSize ?? 20;
  const pageSizeOptions = useMemo(() => {
    const base = [5, 10, 20, 50];
    if (defaultPageSize && !base.includes(defaultPageSize)) {
      return [...base, defaultPageSize].sort((a, b) => a - b);
    }
    return base;
  }, [defaultPageSize]);

  const totalPages = Math.max(1, Math.ceil(items.length / effectivePageSize));
  const pagedItems = items.slice((page - 1) * effectivePageSize, page * effectivePageSize);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await adminRequest("/admin/api/backups");
      if (response.status === 401) {
        window.location.href = "/admin/signin";
        return;
      }
      if (!response.ok) {
        setError(`Could not load backups (HTTP ${response.status}).`);
        return;
      }
      const payload = (await response.json()) as { items: BackupItem[] };
      setItems(payload.items);
      setError("");
    } catch (cause) {
      setError(`Could not reach the backend: ${describeFailure(cause)}.`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void adminRequest("/admin/api/settings")
      .then(async (response) => {
        if (response.ok) {
          const payload = (await response.json()) as { default_page_size?: number };
          if (typeof payload.default_page_size === "number") {
            setDefaultPageSize(payload.default_page_size);
          }
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  async function download(filename: string): Promise<void> {
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const response = await adminRequest(`/admin/api/backups/${encodeURIComponent(filename)}`);
      if (!response.ok) {
        setError(`Download failed (HTTP ${response.status}).`);
        return;
      }
      triggerDownload(await response.blob(), filename);
    } catch (cause) {
      setError(`Download failed: ${describeFailure(cause)}.`);
    } finally {
      setWorking(false);
    }
  }

  async function create(): Promise<void> {
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const csrf = await getCsrfToken();
      const response = await adminRequest("/admin/api/backups", {
        method: "POST",
        headers: { "X-CSRF-Token": csrf },
      });
      if (!response.ok) {
        setError(`Backup creation failed (HTTP ${response.status}).`);
        return;
      }
      const filename = response.headers.get("Content-Disposition")?.match(/filename="?([^";]+)"?/)?.[1];
      if (filename) {
        setNotice(`Created backup ${filename}.`);
      } else {
        setNotice("Backup created successfully.");
      }
      await load();
    } catch (cause) {
      setError(`Backup creation failed: ${describeFailure(cause)}.`);
    } finally {
      setWorking(false);
    }
  }

  async function restore(filename: string): Promise<void> {
    if (!window.confirm(`Restore ${filename}? This will replace the current database, audio, and configuration.`)) return;

    setWorking(true);
    setError("");
    setNotice("");
    try {
      const csrf = await getCsrfToken();
      const response = await adminRequest(`/admin/api/backups/${encodeURIComponent(filename)}/restore`, {
        method: "POST",
        headers: {
          "X-CSRF-Token": csrf,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ confirm: true }),
      });
      if (response.status === 401) {
        window.location.href = "/admin/signin";
        return;
      }
      if (!response.ok) {
        setError(`Restore failed (HTTP ${response.status}).`);
        return;
      }
      const payload = (await response.json()) as { restored_filename: string; recovery_filename: string };
      setNotice(`Restored ${payload.restored_filename}. Recovery backup created: ${payload.recovery_filename}.`);
      await load();
    } catch (cause) {
      setError(`Restore failed: ${describeFailure(cause)}.`);
    } finally {
      setWorking(false);
    }
  }

  async function handleDelete(filename: string): Promise<void> {
    if (!window.confirm(`Delete backup '${filename}'? This cannot be undone.`)) return;

    setWorking(true);
    setError("");
    setNotice("");
    try {
      const csrf = await getCsrfToken();
      const response = await adminRequest(`/admin/api/backups/${encodeURIComponent(filename)}`, {
        method: "DELETE",
        headers: { "X-CSRF-Token": csrf },
      });
      if (response.status === 401) {
        window.location.href = "/admin/signin";
        return;
      }
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(payload.error || `Delete failed (HTTP ${response.status}).`);
        return;
      }
      setNotice(`Backup ${filename} was deleted.`);
      await load();
    } catch (cause) {
      setError(`Delete failed: ${describeFailure(cause)}.`);
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="admin-page">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: "1rem",
          marginBottom: "1.25rem",
        }}
      >
        <div>
          <p className="eyebrow">System</p>
          <h1 style={{ margin: 0 }}>
            Backup &amp; Restore{" "}
            <span className="count" style={{ fontSize: "1.1rem", verticalAlign: "middle" }}>
              {items.length}
            </span>
          </h1>
          <p className="admin-lede" style={{ margin: "0.25rem 0 0 0" }}>
            Create and download portable archive backups.
          </p>
        </div>

        <button
          type="button"
          className="admin-button admin-button--primary"
          onClick={() => void create()}
          disabled={working || loading}
          style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
        >
          <span style={{ fontSize: "1.1rem", lineHeight: 1 }}>+</span> {working ? "Working..." : "Create backup"}
        </button>
      </div>

      {error && (
        <p
          role="alert"
          className="form-error"
          style={{ marginBottom: "1rem", padding: "0.75rem 1rem", borderRadius: "var(--radius-sm, 6px)" }}
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="form-success"
          style={{
            marginBottom: "1rem",
            padding: "0.75rem 1rem",
            borderRadius: "var(--radius-sm, 6px)",
            background: "#f0fdf4",
            color: "#166534",
            border: "1px solid #bbf7d0",
          }}
        >
          {notice}
        </p>
      )}

      <div className="admin-panel" style={{ padding: "0.5rem 1.25rem" }}>
        {loading ? (
          <p className="muted" style={{ padding: "1rem 0" }}>
            Loading backups...
          </p>
        ) : items.length === 0 ? (
          <div style={{ padding: "2rem 0", textAlign: "center" }}>
            <p className="muted" style={{ marginBottom: "0.75rem" }}>
              No backups have been created yet.
            </p>
            <button
              type="button"
              onClick={() => void create()}
              disabled={working}
              className="admin-button admin-button--primary"
            >
              + Create your first backup
            </button>
          </div>
        ) : (
          <>
            <ul className="record-list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {pagedItems.map((item) => (
                <li
                  key={item.filename}
                  className="record-list__item"
                >
                <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "2rem",
                        height: "2rem",
                        borderRadius: "6px",
                        background: "rgba(79, 70, 229, 0.08)",
                        color: "var(--color-primary, #4f46e5)",
                        flexShrink: 0,
                      }}
                      aria-hidden="true"
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                        <line x1="12" y1="22.08" x2="12" y2="12" />
                      </svg>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
                      <strong
                        style={{
                          fontSize: "0.95rem",
                          color: "var(--color-foreground, #0f172a)",
                        }}
                      >
                        {formatDateTime(item.created_at)}
                      </strong>
                      <span
                        style={{
                          fontSize: "0.78rem",
                          fontFamily: "monospace",
                          color: "var(--color-muted, #64748b)",
                          wordBreak: "break-all",
                        }}
                      >
                        {item.filename}
                      </span>
                    </div>
                  </div>
                  <p
                    className="muted"
                    style={{
                      fontSize: "0.8rem",
                      color: "var(--color-muted)",
                      margin: "0.2rem 0 0 2.6rem",
                    }}
                  >
                    {formatSize(item.size_bytes)}
                  </p>
                </div>

                <div className="record-list__actions">
                  <button
                    type="button"
                    className="admin-button admin-button--sm"
                    onClick={() => void download(item.filename)}
                    disabled={working}
                  >
                    Download
                  </button>
                  <button
                    type="button"
                    className="admin-button admin-button--sm"
                    onClick={() => void restore(item.filename)}
                    disabled={working}
                    style={{
                      borderColor: "#fed7aa",
                      background: "#fff7ed",
                      color: "#c2410c",
                    }}
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    className="admin-button admin-button--sm admin-button--danger"
                    onClick={() => void handleDelete(item.filename)}
                    disabled={working}
                    title="Delete backup"
                  >
                    Delete
                  </button>
                </div>
              </li>
              ))}
            </ul>
            {items.length > 0 && (
              <div className="pagination-wrapper">
                <Pagination
                  ariaLabel="Backups pagination"
                  currentPage={page}
                  totalPages={totalPages}
                  totalItems={items.length}
                  pageSize={effectivePageSize}
                  pageSizeOptions={pageSizeOptions}
                  onPageChange={(newPage) => setPage(newPage)}
                  onPageSizeChange={(newSize) => {
                    setPageSize(newSize);
                    setPage(1);
                  }}
                  itemLabel="backups"
                  showPageJumper={totalPages > 4}
                />
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
