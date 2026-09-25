"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { adminRequest, getCsrfToken } from "@/lib/admin-api";
import Input from "@/components/Input";
import Textarea from "@/components/Textarea";
import Select from "@/components/Select";

export interface TextTemplateItem {
  id: number;
  kind: string;
  version: number;
  content: string;
}

const KIND_OPTIONS = [
  { value: "consent", label: "Informed Consent (consent)" },
  { value: "completion", label: "Study Completion (completion)" },
  { value: "instructions", label: "Setup & Instructions (instructions)" },
  { value: "custom", label: "Custom kind..." },
];

function getKindBadgeColor(kind: string): { bg: string; color: string; border: string } {
  switch (kind.toLowerCase()) {
    case "consent":
      return { bg: "#eff6ff", color: "#1d4ed8", border: "#bfdbfe" };
    case "completion":
      return { bg: "#f0fdf4", color: "#15803d", border: "#bbf7d0" };
    case "instructions":
      return { bg: "#fffbeb", color: "#b45309", border: "#fde68a" };
    default:
      return { bg: "#f3f4f6", color: "#374151", border: "#e5e7eb" };
  }
}

export default function TextTemplatesPage() {
  const [items, setItems] = useState<TextTemplateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Create form state
  const [isAdding, setIsAdding] = useState(false);
  const [newKindPreset, setNewKindPreset] = useState("consent");
  const [newCustomKind, setNewCustomKind] = useState("");
  const [newVersion, setNewVersion] = useState("");
  const [newContent, setNewContent] = useState("");
  const [createError, setCreateError] = useState("");

  // Inline edit state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editKind, setEditKind] = useState("");
  const [editVersion, setEditVersion] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editError, setEditError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const response = await adminRequest("/admin/api/text-templates");
    if (response.status === 401) {
      window.location.href = "/admin/signin";
      return;
    }
    if (response.ok) {
      const payload = (await response.json()) as { items: TextTemplateItem[] };
      setItems(payload.items ?? []);
    } else {
      setError("Could not load text templates.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Start adding new template
  function startAdding() {
    setIsAdding(true);
    setNewKindPreset("consent");
    setNewCustomKind("");
    setNewVersion("");
    setNewContent("");
    setCreateError("");
    setEditingId(null);
  }

  function cancelAdding() {
    setIsAdding(false);
    setNewKindPreset("consent");
    setNewCustomKind("");
    setNewVersion("");
    setNewContent("");
    setCreateError("");
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setCreateError("");

    const kind = (newKindPreset === "custom" ? newCustomKind : newKindPreset).trim().toLowerCase();
    if (!kind) {
      setCreateError("Template kind is required.");
      return;
    }

    const content = newContent.trim();
    if (!content) {
      setCreateError("Template content is required.");
      return;
    }

    const csrf = await getCsrfToken();
    const payload: Record<string, unknown> = {
      kind,
      content,
    };

    if (newVersion.trim()) {
      const parsedVer = parseInt(newVersion.trim(), 10);
      if (isNaN(parsedVer) || parsedVer < 1) {
        setCreateError("Version must be a positive integer.");
        return;
      }
      payload.version = parsedVer;
    }

    const response = await adminRequest("/admin/api/text-templates", {
      method: "POST",
      headers: { "X-CSRF-Token": csrf },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as {
        errors?: string[];
        error?: string;
      };
      const errMsg = data.errors?.join("; ") || data.error || "Could not create text template.";
      setCreateError(errMsg);
      return;
    }

    cancelAdding();
    void load();
  }

  // Start inline editing
  function startEdit(item: TextTemplateItem) {
    setEditingId(item.id);
    setEditKind(item.kind || "");
    setEditVersion(String(item.version || 1));
    setEditContent(item.content || "");
    setEditError("");
    setIsAdding(false);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditKind("");
    setEditVersion("");
    setEditContent("");
    setEditError("");
  }

  async function handleSaveEdit(event: FormEvent, id: number) {
    event.preventDefault();
    setEditError("");

    const kind = editKind.trim().toLowerCase();
    if (!kind) {
      setEditError("Template kind is required.");
      return;
    }

    const content = editContent.trim();
    if (!content) {
      setEditError("Template content is required.");
      return;
    }

    const parsedVer = parseInt(editVersion.trim(), 10);
    if (isNaN(parsedVer) || parsedVer < 1) {
      setEditError("Version must be a positive integer.");
      return;
    }

    const csrf = await getCsrfToken();
    const payload = {
      kind,
      version: parsedVer,
      content,
    };

    const response = await adminRequest(`/admin/api/text-templates/${id}`, {
      method: "PUT",
      headers: { "X-CSRF-Token": csrf },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as {
        errors?: string[];
        error?: string;
      };
      const errMsg = data.errors?.join("; ") || data.error || "Could not update text template.";
      setEditError(errMsg);
      return;
    }

    cancelEdit();
    void load();
  }

  async function handleDelete(item: TextTemplateItem) {
    if (!confirm(`Are you sure you want to delete ${item.kind} template (v${item.version})?`)) {
      return;
    }
    setError("");
    const csrf = await getCsrfToken();
    const response = await adminRequest(`/admin/api/text-templates/${item.id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrf },
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      const msg = data.error || "Could not delete text template.";
      setError(msg);
      return;
    }

    if (editingId === item.id) {
      cancelEdit();
    }
    void load();
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
          <p className="eyebrow">Master data</p>
          <h1 style={{ margin: 0 }}>
            Text Templates <span className="count" style={{ fontSize: "1.1rem", verticalAlign: "middle" }}>{items.length}</span>
          </h1>
        </div>

        {!isAdding && (
          <button
            type="button"
            onClick={startAdding}
            className="admin-button admin-button--primary"
            style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
          >
            <span style={{ fontSize: "1.1rem", lineHeight: 1 }}>+</span> Add template
          </button>
        )}
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

      {/* New Template Form */}
      {isAdding && (
        <form
          onSubmit={handleCreate}
          className="admin-panel"
          style={{
            marginBottom: "1.25rem",
            border: "2px solid var(--color-primary, #4f46e5)",
            background: "#fdfefe",
            padding: "1.25rem",
            borderRadius: "var(--radius-md, 8px)",
          }}
        >
          <h2 style={{ fontSize: "1.05rem", marginTop: 0, marginBottom: "0.75rem" }}>
            Add new text template
          </h2>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0.75rem" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontWeight: 600, fontSize: "0.9rem" }}>
                Template Kind / Purpose
                <Select
                  value={newKindPreset}
                  onChange={(e) => setNewKindPreset(e.target.value)}
                >
                  {KIND_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </Select>
              </label>

              {newKindPreset === "custom" && (
                <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontWeight: 600, fontSize: "0.9rem" }}>
                  Custom Kind Name
                  <Input
                    value={newCustomKind}
                    onChange={(e) => setNewCustomKind(e.target.value)}
                    placeholder="e.g. debrief, privacy_notice"
                    required
                  />
                </label>
              )}

              <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontWeight: 600, fontSize: "0.9rem" }}>
                <span>
                  Version <span className="muted" style={{ fontWeight: 400, fontSize: "0.8rem" }}>(optional, auto-incremented)</span>
                </span>
                <Input
                  type="number"
                  min="1"
                  value={newVersion}
                  onChange={(e) => setNewVersion(e.target.value)}
                  placeholder="Auto (next version)"
                />
              </label>
            </div>

            <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontWeight: 600, fontSize: "0.9rem" }}>
              Content / Markdown Text
              <Textarea
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                placeholder="Enter template text (e.g. informed consent statement or study debrief message)..."
                rows={5}
                required
              />
            </label>

            {createError && <p role="alert" className="form-error" style={{ margin: 0 }}>{createError}</p>}

            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.25rem", flexWrap: "wrap" }}>
              <button type="submit" className="admin-button admin-button--primary">
                Create Template
              </button>
              <button
                type="button"
                onClick={cancelAdding}
                className="admin-button"
                style={{ background: "transparent", border: "1px solid var(--color-border)" }}
              >
                Cancel
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Templates List Panel */}
      <div className="admin-panel" style={{ padding: "0.5rem 1.25rem" }}>
        {loading ? (
          <p className="muted" style={{ padding: "1rem 0" }}>Loading text templates…</p>
        ) : items.length === 0 && !isAdding ? (
          <div style={{ padding: "2rem 0", textAlign: "center" }}>
            <p className="muted" style={{ marginBottom: "0.75rem" }}>No text templates added yet.</p>
            <button type="button" onClick={startAdding} className="admin-button admin-button--primary">
              + Add your first template
            </button>
          </div>
        ) : (
          <ul className="record-list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {items.map((item) => {
              const isEditing = editingId === item.id;
              const badgeStyle = getKindBadgeColor(item.kind);

              if (isEditing) {
                return (
                  <li
                    key={item.id}
                    style={{
                      padding: "1rem",
                      margin: "0.75rem -0.5rem",
                      background: "var(--color-surface, #ffffff)",
                      border: "2px solid var(--color-primary, #4f46e5)",
                      borderRadius: "var(--radius-sm, 6px)",
                      boxShadow: "0 2px 8px rgba(79, 70, 229, 0.08)",
                    }}
                  >
                    <form onSubmit={(e) => handleSaveEdit(e, item.id)}>
                      <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.75rem 0", color: "var(--color-primary)" }}>
                        Editing Template #{item.id}
                      </h3>

                      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.75rem" }}>
                          <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontWeight: 600, fontSize: "0.85rem" }}>
                            Kind
                            <Input
                              value={editKind}
                              onChange={(e) => setEditKind(e.target.value)}
                              placeholder="e.g. consent, completion"
                              required
                            />
                          </label>

                          <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontWeight: 600, fontSize: "0.85rem" }}>
                            Version
                            <Input
                              type="number"
                              min="1"
                              value={editVersion}
                              onChange={(e) => setEditVersion(e.target.value)}
                              required
                            />
                          </label>
                        </div>

                        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontWeight: 600, fontSize: "0.85rem" }}>
                          Content
                          <Textarea
                            value={editContent}
                            onChange={(e) => setEditContent(e.target.value)}
                            placeholder="Template content"
                            rows={4}
                            required
                          />
                        </label>

                        {editError && <p role="alert" className="form-error" style={{ margin: 0 }}>{editError}</p>}

                        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.25rem", flexWrap: "wrap" }}>
                          <button type="submit" className="admin-button admin-button--primary">
                            Save Changes
                          </button>
                          <button
                            type="button"
                            onClick={cancelEdit}
                            className="admin-button"
                            style={{ background: "transparent", border: "1px solid var(--color-border)" }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    </form>
                  </li>
                );
              }

              return (
                <li
                  key={item.id}
                  className="record-list__item"
                >
                  <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
                      <span
                        style={{
                          display: "inline-block",
                          padding: "0.15rem 0.55rem",
                          fontSize: "0.75rem",
                          fontWeight: 600,
                          borderRadius: "4px",
                          background: badgeStyle.bg,
                          color: badgeStyle.color,
                          border: `1px solid ${badgeStyle.border}`,
                          textTransform: "capitalize",
                        }}
                      >
                        {item.kind}
                      </span>
                      <span
                        style={{
                          display: "inline-block",
                          padding: "0.15rem 0.45rem",
                          fontSize: "0.72rem",
                          fontWeight: 500,
                          borderRadius: "4px",
                          background: "var(--color-surface-soft)",
                          color: "var(--color-muted)",
                          border: "1px solid var(--color-border)",
                        }}
                      >
                        v{item.version}
                      </span>
                    </div>

                    {item.content && (
                      <p style={{ fontSize: "0.8rem", color: "var(--color-muted)", margin: "0.2rem 0 0 0", whiteSpace: "pre-wrap" }}>
                        {item.content}
                      </p>
                    )}
                  </div>

                  <div className="record-list__actions">
                    <button
                      type="button"
                      onClick={() => startEdit(item)}
                      className="admin-button admin-button--sm"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(item)}
                      title="Delete template"
                      className="admin-button admin-button--sm admin-button--danger"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

