"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { adminRequest, getCsrfToken } from "@/lib/admin-api";
import Input from "@/components/Input";
import Textarea from "@/components/Textarea";

export interface EngineItem {
  id: number;
  name: string;
  description?: string | null;
}

export default function EnginesPage() {
  const [items, setItems] = useState<EngineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Create form state
  const [isAdding, setIsAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [createError, setCreateError] = useState("");

  // Inline edit state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editError, setEditError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const response = await adminRequest("/admin/api/engines");
    if (response.status === 401) {
      window.location.href = "/admin/signin";
      return;
    }
    if (response.ok) {
      const payload = (await response.json()) as { items: EngineItem[] };
      setItems(payload.items ?? []);
    } else {
      setError("Could not load engines.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Start adding new engine
  function startAdding() {
    setIsAdding(true);
    setNewName("");
    setNewDescription("");
    setCreateError("");
    setEditingId(null);
  }

  function cancelAdding() {
    setIsAdding(false);
    setNewName("");
    setNewDescription("");
    setCreateError("");
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setCreateError("");

    const trimmedName = newName.trim();
    if (!trimmedName) {
      setCreateError("Engine name is required.");
      return;
    }

    const csrf = await getCsrfToken();
    const payload = {
      name: trimmedName,
      description: newDescription.trim() || undefined,
    };

    const response = await adminRequest("/admin/api/engines", {
      method: "POST",
      headers: { "X-CSRF-Token": csrf },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as {
        errors?: string[];
        error?: string;
      };
      const errMsg = data.errors?.join("; ") || data.error || "Could not create engine.";
      setCreateError(errMsg);
      return;
    }

    cancelAdding();
    void load();
  }

  // Start inline editing
  function startEdit(item: EngineItem) {
    setEditingId(item.id);
    setEditName(item.name || "");
    setEditDescription(item.description || "");
    setEditError("");
    setIsAdding(false);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditName("");
    setEditDescription("");
    setEditError("");
  }

  async function handleSaveEdit(event: FormEvent, id: number) {
    event.preventDefault();
    setEditError("");

    const trimmedName = editName.trim();
    if (!trimmedName) {
      setEditError("Engine name is required.");
      return;
    }

    const csrf = await getCsrfToken();
    const payload = {
      name: trimmedName,
      description: editDescription.trim() || undefined,
    };

    const response = await adminRequest(`/admin/api/engines/${id}`, {
      method: "PUT",
      headers: { "X-CSRF-Token": csrf },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as {
        errors?: string[];
        error?: string;
      };
      const errMsg = data.errors?.join("; ") || data.error || "Could not update engine.";
      setEditError(errMsg);
      return;
    }

    cancelEdit();
    void load();
  }

  async function handleDelete(item: EngineItem) {
    if (!confirm(`Are you sure you want to delete engine '${item.name}'?`)) {
      return;
    }
    setError("");
    const csrf = await getCsrfToken();
    const response = await adminRequest(`/admin/api/engines/${item.id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrf },
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      const msg =
        response.status === 409
          ? `Cannot delete '${item.name}': This engine is currently referenced by one or more tests.`
          : data.error || "Could not delete engine.";
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
            Engines <span className="count" style={{ fontSize: "1.1rem", verticalAlign: "middle" }}>{items.length}</span>
          </h1>
        </div>

        {!isAdding && (
          <button
            type="button"
            onClick={startAdding}
            className="admin-button admin-button--primary"
            style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
          >
            <span style={{ fontSize: "1.1rem", lineHeight: 1 }}>+</span> Add engine
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

      {/* New Engine Inline Form */}
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
            Add new engine
          </h2>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontWeight: 600, fontSize: "0.9rem" }}>
              Engine Name
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. ElevenLabs, Google TTS, XTTS-v2"
                autoFocus
                required
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontWeight: 600, fontSize: "0.9rem" }}>
              Description <span className="muted" style={{ fontWeight: 400, fontSize: "0.8rem" }}>(optional)</span>
              <Textarea
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Optional notes or details about the model/engine"
                rows={2}
              />
            </label>

            {createError && <p role="alert" className="form-error" style={{ margin: 0 }}>{createError}</p>}

            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.25rem", flexWrap: "wrap" }}>
              <button type="submit" className="admin-button admin-button--primary">
                Create Engine
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

      {/* Engines List Panel */}
      <div className="admin-panel" style={{ padding: "0.5rem 1.25rem" }}>
        {loading ? (
          <p className="muted" style={{ padding: "1rem 0" }}>Loading engines…</p>
        ) : items.length === 0 && !isAdding ? (
          <div style={{ padding: "2rem 0", textAlign: "center" }}>
            <p className="muted" style={{ marginBottom: "0.75rem" }}>No engines added yet.</p>
            <button type="button" onClick={startAdding} className="admin-button admin-button--primary">
              + Add your first engine
            </button>
          </div>
        ) : (
          <ul className="record-list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {items.map((item) => {
              const isEditing = editingId === item.id;

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
                        Editing Engine #{item.id}
                      </h3>

                      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontWeight: 600, fontSize: "0.85rem" }}>
                          Engine Name
                          <Input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            placeholder="e.g. ElevenLabs"
                            autoFocus
                            required
                          />
                        </label>

                        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontWeight: 600, fontSize: "0.85rem" }}>
                          Description
                          <Textarea
                            value={editDescription}
                            onChange={(e) => setEditDescription(e.target.value)}
                            placeholder="Optional notes or details"
                            rows={2}
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
                    <strong style={{ fontSize: "0.95rem", color: "var(--color-foreground)" }}>
                      {item.name}
                    </strong>
                    {item.description && (
                      <p style={{ fontSize: "0.8rem", color: "var(--color-muted)", margin: "0.15rem 0 0 0" }}>
                        {item.description}
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
                      title="Delete engine"
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
