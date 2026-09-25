"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { adminRequest, getCsrfToken } from "../../../../lib/admin-api";
import Input from "../../../../components/Input";
import { Pagination } from "../../../../components/Pagination";

const labels: Record<string, string> = {
  engines: "Engines",
  "mos-scales": "MOS Scales",
  "demographic-fields": "Demographic Fields",
  "text-templates": "Text Templates",
};

function buildPayload(entity: string, name: string): Record<string, unknown> {
  switch (entity) {
    case "engines":
      return { name };
    case "mos-scales":
      return { name, min: 1, max: 5, labels: ["1", "2", "3", "4", "5"], prompt: name };
    case "demographic-fields":
      return { key: name, label: name };
    default:
      return { kind: "consent", content: name };
  }
}

export default function MasterDataPage() {
  const { entity } = useParams<{ entity: string }>();
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
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
    const response = await adminRequest(`/admin/api/${entity}`);
    if (response.status === 401) {
      window.location.href = "/admin/signin";
      return;
    }
    if (response.ok) {
      const payload = (await response.json()) as { items: Record<string, unknown>[] };
      setItems(payload.items);
    }
  }, [entity]);

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

  async function create(event: FormEvent) {
    event.preventDefault();
    const csrf = await getCsrfToken();
    const response = await adminRequest(`/admin/api/${entity}`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrf },
      body: JSON.stringify(buildPayload(entity, name)),
    });
    if (!response.ok) {
      setError("Could not create record.");
      return;
    }
    setName("");
    setError("");
    void load();
  }

  return (
    <section className="admin-page">
      <p className="eyebrow">Master data</p>
      <h1>{labels[entity] ?? "Master data"}</h1>
      <div className="admin-grid">
        <form onSubmit={create} className="admin-panel admin-form">
          <h2>Add record</h2>
          <label>
            Name
            <Input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          {error && <p role="alert" className="form-error">{error}</p>}
          <button className="admin-button admin-button--primary">Create</button>
        </form>
        <div className="admin-panel">
          <h2>Records <span className="count">{items.length}</span></h2>
          {items.length === 0 ? (
            <p className="muted">No records yet.</p>
          ) : (
            <>
              <ul className="record-list">
                {pagedItems.map((item, index) => (
                  <li key={String(item.id ?? index)}>
                    {String(item.name ?? item.label ?? item.key ?? item.text ?? item.content)}
                  </li>
                ))}
              </ul>
              {items.length > 0 && (
                <div className="pagination-wrapper">
                  <Pagination
                    ariaLabel={`${labels[entity] ?? "Master data"} pagination`}
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
                    itemLabel="records"
                    showPageJumper={totalPages > 4}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}