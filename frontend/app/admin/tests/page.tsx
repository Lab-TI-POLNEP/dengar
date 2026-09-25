"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { adminRequest, getCsrfToken } from "@/lib/admin-api";
import { Pagination } from "@/components/Pagination";

type Test = {
  id: number;
  name: string;
  version: number;
  status: string;
  access_code?: string | null;
};

export default function TestsPage() {
  const [tests, setTests] = useState<Test[]>([]);
  const [actionError, setActionError] = useState("");
  const [defaultPageSize, setDefaultPageSize] = useState<number | null>(null);
  const [pageSize, setPageSize] = useState<number | null>(null);
  const [page, setPage] = useState(1);

  const effectivePageSize = pageSize ?? defaultPageSize ?? 5;
  const pageSizeOptions = useMemo(() => {
    const base = [5, 10, 20, 50];
    if (defaultPageSize && !base.includes(defaultPageSize)) {
      return [...base, defaultPageSize].sort((a, b) => a - b);
    }
    return base;
  }, [defaultPageSize]);

  const totalPages = Math.max(1, Math.ceil(tests.length / effectivePageSize));
  const pagedTests = tests.slice((page - 1) * effectivePageSize, page * effectivePageSize);

  const summary = useMemo(
    () => ({
      drafts: tests.filter((t) => t.status === "draft").length,
      published: tests.filter((t) => t.status === "published").length,
    }),
    [tests]
  );

  async function loadTests() {
    const response = await adminRequest("/admin/api/tests");
    if (response.status === 401) {
      window.location.href = "/admin/signin";
      return;
    }
    if (response.ok) {
      try {
        const payload = (await response.json()) as { items: Test[] };
        setTests(payload.items);
      } catch {
        setActionError("Server returned an invalid response. Please verify that the backend API is running.");
      }
    }
  }

  useEffect(() => {
    void adminRequest("/admin/api/settings")
      .then(async (response) => {
        const contentType = response.headers?.get?.("content-type") ?? "";
        if (response.ok && (!contentType || contentType.includes("application/json"))) {
          const payload = (await response.json()) as { default_page_size?: number };
          if (typeof payload.default_page_size === "number") {
            setDefaultPageSize(payload.default_page_size);
          }
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void loadTests();
  }, []);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  async function handleDelete(testId: number, name: string, status: string) {
    const label = status === "draft" ? "draft" : "published test";
    if (!window.confirm(`Delete ${label} "${name}"? This cannot be undone.`)) return;
    setActionError("");
    const csrf = await getCsrfToken();
    const response = await adminRequest(`/admin/api/tests/${testId}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrf },
    });
    if (!response.ok) {
      let message = "Could not delete the test.";
      try {
        const payload = (await response.json()) as { error?: string };
        if (payload?.error) {
          message = payload.error;
        }
      } catch {
        // Ignore invalid JSON and keep generic message.
      }
      setActionError(message);
      return;
    }
    void loadTests();
  }

  async function handlePublish(testId: number) {
    setActionError("");
    const csrf = await getCsrfToken();
    const response = await adminRequest(`/admin/api/tests/${testId}/publish`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrf },
    });
    if (!response.ok) {
      let message = "Could not publish the test.";
      try {
        const payload = (await response.json()) as { error?: string; errors?: string[] };
        if (payload?.errors?.length) {
          message = payload.errors.join(" ");
        } else if (payload?.error) {
          message = payload.error;
        }
      } catch {
        // Ignore invalid JSON
      }
      setActionError(message);
      return;
    }
    void loadTests();
  }

  async function handleUnpublish(testId: number) {
    setActionError("");
    const csrf = await getCsrfToken();
    const response = await adminRequest(`/admin/api/tests/${testId}/unpublish`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrf },
    });
    if (!response.ok) {
      let message = "Could not unpublish the test.";
      try {
        const payload = (await response.json()) as { error?: string };
        if (payload?.error) {
          message = payload.error;
        }
      } catch {
        // Ignore invalid JSON
      }
      setActionError(message);
      return;
    }
    void loadTests();
  }

  async function handleExportYaml(testId: number) {
    setActionError("");
    const csrf = await getCsrfToken();
    const response = await adminRequest(`/admin/api/tests/${testId}/export/yaml`, {
      method: "GET",
      headers: { "X-CSRF-Token": csrf },
    });
    if (!response.ok) {
      let message = "Could not export YAML.";
      try {
        const payload = (await response.json()) as { error?: string };
        if (payload?.error) {
          message = payload.error;
        }
      } catch {
        // Ignore invalid JSON
      }
      setActionError(message);
      return;
    }
    // Trigger browser download
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    // Extract filename from Content-Disposition header if available
    const disposition = response.headers.get("Content-Disposition");
    const match = disposition?.match(/filename="?([^"]+)"?/);
    link.download = match ? match[1] : `test_${testId}.yaml`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  async function handleAccessCodeAction(testId: number, action: "enable" | "disable" | "regenerate") {
    setActionError("");
    const csrf = await getCsrfToken();
    const response = await adminRequest(`/admin/api/tests/${testId}/access-code`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrf },
      body: JSON.stringify({ action }),
    });
    if (!response.ok) {
      let message = "Could not update the access code.";
      try {
        const payload = (await response.json()) as { error?: string; errors?: string[] };
        if (payload?.errors?.length) {
          message = payload.errors.join(" ");
        } else if (payload?.error) {
          message = payload.error;
        }
      } catch {
        // Ignore invalid JSON and keep generic message.
      }
      setActionError(message);
      return;
    }
    void loadTests();
  }

  return (
    <section className="admin-page tests-page">
      <header className="tests-page__header">
        <div className="tests-page__title">
          <p className="eyebrow">Studies</p>
          <h1>Tests</h1>
          <p className="admin-lede">Create and manage speech-evaluation test configurations.</p>
        </div>
        <Link href="/admin/tests/new" className="admin-button admin-button--primary tests-page__cta">
          <span aria-hidden="true">+</span> New test
        </Link>
      </header>

      <section className="test-library" aria-labelledby="test-library-heading">
        <div className="test-library__header">
          <div>
            <h2 id="test-library-heading">Your tests</h2>
            <p className="muted">
              {tests.length === 0
                ? "Start a guided setup or restore an exported configuration."
                : `${summary.drafts} draft${summary.drafts === 1 ? "" : "s"} · ${summary.published} published`}
            </p>
          </div>
          <span className="test-library__count" aria-label={`${tests.length} tests`}>
            {tests.length}
          </span>
        </div>

        {actionError && (
          <p role="alert" className="form-error test-library__error">
            {actionError}
          </p>
        )}

        {tests.length === 0 ? (
          <div className="tests-empty">
            <div className="tests-empty__icon" aria-hidden="true">
              +
            </div>
            <h3>Create your first test</h3>
            <p>Use the guided wizard to name a study, choose audio, and prepare the evaluation flow.</p>
            <Link href="/admin/tests/new" className="admin-button admin-button--primary">
              Create a test
            </Link>
          </div>
        ) : (
          <>
            <ul className="test-list">
              {pagedTests.map((test) => {
                const isDraft = test.status === "draft";
                return (
                  <li className="test-list__item" key={test.id}>
                  <div className="test-list__identity">
                    <div className="test-list__title-row">
                      <h3>{test.name}</h3>
                      <span className={`status-badge status-badge--${isDraft ? "draft" : "published"}`}>
                        {isDraft ? "Draft" : "Published"}
                      </span>
                    </div>
                    <p>
                      Version {test.version} · Test #{test.id}
                    </p>
                    {test.status === "published" && (
                      <div className="test-list__access-code">
                        <span className="muted">Access Code:</span>
                        {test.access_code ? (
                          <>
                            <strong className="test-list__access-code-badge">
                              {test.access_code}
                            </strong>
                            <button
                              type="button"
                              className="admin-button admin-button--xs"
                              onClick={() => {
                                void navigator.clipboard.writeText(test.access_code || "");
                                alert("Access code copied to clipboard!");
                              }}
                            >
                              Copy
                            </button>
                            <button
                              type="button"
                              className="admin-button admin-button--xs"
                              onClick={() => void handleAccessCodeAction(test.id, "regenerate")}
                            >
                              Regenerate
                            </button>
                            <button
                              type="button"
                              className="admin-button admin-button--xs admin-button--danger"
                              onClick={() => void handleAccessCodeAction(test.id, "disable")}
                            >
                              Disable
                            </button>
                          </>
                        ) : (
                          <>
                            <span className="muted" style={{ fontStyle: "italic" }}>Disabled</span>
                            <button
                              type="button"
                              className="admin-button admin-button--xs"
                              onClick={() => void handleAccessCodeAction(test.id, "enable")}
                            >
                              Enable
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="test-list__actions">
                    <Link
                    href={`/admin/tests/new?id=${test.id}`}
                    className="admin-button admin-button--primary"
                  >
                    {isDraft ? "Continue editing" : "Edit published"}
                  </Link>
                  {isDraft ? (
                    <button type="button" className="admin-button" onClick={() => handlePublish(test.id)}>
                      Publish
                    </button>
                  ) : (
                    <>
                      <button type="button" className="admin-button" onClick={() => handleExportYaml(test.id)}>
                        Export YAML
                      </button>
                      <button type="button" className="admin-button" onClick={() => handleUnpublish(test.id)}>
                        Unpublish
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="admin-button admin-button--danger"
                    onClick={() => handleDelete(test.id, test.name, test.status)}
                  >
                    Delete
                  </button>
                  </div>
                  </li>
                );
              })}
            </ul>
            {tests.length > 0 && (
              <div className="pagination-wrapper">
                <Pagination
                  ariaLabel="Tests pagination"
                  currentPage={page}
                  totalPages={totalPages}
                  totalItems={tests.length}
                  pageSize={effectivePageSize}
                  pageSizeOptions={pageSizeOptions}
                  onPageChange={(newPage) => setPage(newPage)}
                  onPageSizeChange={(newSize) => {
                    setPageSize(newSize);
                    setPage(1);
                  }}
                  itemLabel="tests"
                  showPageJumper={totalPages > 4}
                />
              </div>
            )}
          </>
        )}
      </section>
    </section>
  );
}
