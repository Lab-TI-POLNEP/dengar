"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { adminRequest, getCsrfToken } from "@/lib/admin-api";
import Input from "@/components/Input";
import Checkbox from "@/components/Checkbox";
import Select from "@/components/Select";

export interface DemographicField {
  id: number;
  key: string;
  label: string;
  field_type: string;
  required: boolean;
  options?: string[];
}

interface FieldFormData {
  label: string;
  key: string;
  fieldType: string;
  required: boolean;
  options: string[];
}

const PREDEFINED_KEYS = new Set([
  "age",
  "gender",
  "native_speaker",
  "normal_hearing",
  "experience",
]);

export default function DemographicFieldsPage() {
  const [items, setItems] = useState<DemographicField[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalError, setGlobalError] = useState("");

  // Adding state
  const [isAdding, setIsAdding] = useState(false);
  const [createForm, setCreateForm] = useState<FieldFormData>({
    label: "",
    key: "",
    fieldType: "text",
    required: false,
    options: [],
  });
  const [newOptionTextCreate, setNewOptionTextCreate] = useState("");
  const [createError, setCreateError] = useState("");

  // Inline editing state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<FieldFormData>({
    label: "",
    key: "",
    fieldType: "text",
    required: false,
    options: [],
  });
  const [newOptionTextEdit, setNewOptionTextEdit] = useState("");
  const [editError, setEditError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const response = await adminRequest("/admin/api/demographic-fields");
    if (response.status === 401) {
      window.location.href = "/admin/signin";
      return;
    }
    if (response.ok) {
      const payload = (await response.json()) as { items: DemographicField[] };
      setItems(payload.items ?? []);
    } else {
      setGlobalError("Could not load demographic fields.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // --- Add actions ---
  function startAdding() {
    setIsAdding(true);
    setCreateForm({
      label: "",
      key: "",
      fieldType: "text",
      required: false,
      options: [],
    });
    setNewOptionTextCreate("");
    setCreateError("");
    setEditingId(null);
  }

  function cancelAdding() {
    setIsAdding(false);
    setCreateError("");
  }

  function addOptionCreate() {
    const trimmed = newOptionTextCreate.trim();
    if (!trimmed) return;
    if (createForm.options.includes(trimmed)) {
      setCreateError(`Option '${trimmed}' already exists.`);
      return;
    }
    setCreateError("");
    setCreateForm((prev) => ({ ...prev, options: [...prev.options, trimmed] }));
    setNewOptionTextCreate("");
  }

  function removeOptionCreate(index: number) {
    setCreateForm((prev) => ({
      ...prev,
      options: prev.options.filter((_, i) => i !== index),
    }));
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setCreateError("");

    const isChoiceType =
      createForm.fieldType === "select" || createForm.fieldType === "radio";

    const payload: Record<string, unknown> = {
      label: createForm.label,
      key: createForm.key.trim() || undefined,
      field_type: createForm.fieldType,
      required: createForm.required,
      options: isChoiceType ? createForm.options : [],
    };

    const csrf = await getCsrfToken();
    const response = await adminRequest("/admin/api/demographic-fields", {
      method: "POST",
      headers: { "X-CSRF-Token": csrf },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as {
        errors?: string[];
        error?: string;
      };
      const errMsg =
        data.errors?.join("; ") || data.error || "Could not create record.";
      setCreateError(errMsg);
      return;
    }

    cancelAdding();
    void load();
  }

  // --- Inline edit actions ---
  function startEdit(item: DemographicField) {
    setEditingId(item.id);
    setEditForm({
      label: item.label || "",
      key: item.key || "",
      fieldType: item.field_type ? item.field_type.toLowerCase() : "text",
      required: Boolean(item.required),
      options: Array.isArray(item.options) ? [...item.options] : [],
    });
    setNewOptionTextEdit("");
    setEditError("");
    setIsAdding(false);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError("");
  }

  function addOptionEdit() {
    const trimmed = newOptionTextEdit.trim();
    if (!trimmed) return;
    if (editForm.options.includes(trimmed)) {
      setEditError(`Option '${trimmed}' already exists.`);
      return;
    }
    setEditError("");
    setEditForm((prev) => ({ ...prev, options: [...prev.options, trimmed] }));
    setNewOptionTextEdit("");
  }

  function removeOptionEdit(index: number) {
    setEditForm((prev) => ({
      ...prev,
      options: prev.options.filter((_, i) => i !== index),
    }));
  }

  async function handleSaveEdit(event: FormEvent, id: number) {
    event.preventDefault();
    setEditError("");

    const isChoiceType =
      editForm.fieldType === "select" || editForm.fieldType === "radio";

    const payload: Record<string, unknown> = {
      label: editForm.label,
      key: editForm.key.trim() || undefined,
      field_type: editForm.fieldType,
      required: editForm.required,
      options: isChoiceType ? editForm.options : [],
    };

    const csrf = await getCsrfToken();
    const response = await adminRequest(`/admin/api/demographic-fields/${id}`, {
      method: "PUT",
      headers: { "X-CSRF-Token": csrf },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as {
        errors?: string[];
        error?: string;
      };
      const errMsg =
        data.errors?.join("; ") || data.error || "Could not update record.";
      setEditError(errMsg);
      return;
    }

    cancelEdit();
    void load();
  }

  async function handleDelete(item: DemographicField) {
    if (PREDEFINED_KEYS.has(item.key)) {
      if (item.key === "normal_hearing") {
        setGlobalError("Mandatory field 'normal_hearing' cannot be deleted.");
      } else {
        setGlobalError(`Predefined field '${item.key}' cannot be deleted.`);
      }
      return;
    }
    if (!confirm(`Are you sure you want to delete '${item.label}'?`)) {
      return;
    }
    setGlobalError("");
    const csrf = await getCsrfToken();
    const response = await adminRequest(`/admin/api/demographic-fields/${item.id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrf },
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      setGlobalError(data.error || "Could not delete record.");
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
          <p className="eyebrow">Master Data</p>
          <h1 style={{ margin: 0 }}>
            Demographic Fields <span className="count" style={{ fontSize: "1.1rem", verticalAlign: "middle" }}>{items.length}</span>
          </h1>
        </div>

        {!isAdding && (
          <button
            type="button"
            onClick={startAdding}
            className="admin-button admin-button--primary"
            style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
          >
            <span style={{ fontSize: "1.1rem", lineHeight: 1 }}>+</span> Add field
          </button>
        )}
      </div>

      {globalError && (
        <p
          role="alert"
          className="form-error"
          style={{ marginBottom: "1rem", padding: "0.75rem 1rem", borderRadius: "var(--radius-sm, 6px)" }}
        >
          {globalError}
        </p>
      )}

      {/* Add New Field In-Place Form */}
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
          <h2 style={{ fontSize: "1.05rem", margin: "0 0 0.75rem 0" }}>
            Add new demographic field
          </h2>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontWeight: 600, fontSize: "0.9rem" }}>
              Name (Label)
              <Input
                value={createForm.label}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, label: e.target.value }))}
                placeholder="e.g. Age range, Education level"
                autoFocus
                required
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontWeight: 600, fontSize: "0.9rem" }}>
              Key <span className="muted" style={{ fontWeight: 400, fontSize: "0.8rem" }}>(optional, alphanumeric & underscores)</span>
              <Input
                value={createForm.key}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, key: e.target.value }))}
                placeholder={
                  createForm.label
                    .trim()
                    .toLowerCase()
                    .replace(/[^a-z0-9_]/g, "_")
                    .replace(/_+/g, "_") || "e.g. age_range"
                }
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontWeight: 600, fontSize: "0.9rem" }}>
              Field Type
              <Select
                value={createForm.fieldType}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, fieldType: e.target.value }))}
              >
                <option value="text">Text (Short Text)</option>
                <option value="number">Number (Numeric Input)</option>
                <option value="select">Select (Dropdown)</option>
                <option value="radio">Radio Buttons</option>
              </Select>
            </label>

            {(createForm.fieldType === "select" || createForm.fieldType === "radio") && (
              <div
                style={{
                  padding: "0.75rem",
                  borderRadius: "var(--radius-sm, 6px)",
                  border: "1px solid var(--color-border, #e5e7eb)",
                  background: "var(--color-surface-soft, #f9fafb)",
                }}
              >
                <label style={{ fontWeight: 600, fontSize: "0.85rem", display: "block", marginBottom: "0.4rem" }}>
                  Answer Options
                </label>

                {createForm.options.length === 0 ? (
                  <p className="muted" style={{ fontSize: "0.8rem", margin: "0.25rem 0 0.5rem 0" }}>
                    No answer options yet. Add one below.
                  </p>
                ) : (
                  <ul style={{ listStyle: "none", padding: 0, margin: "0 0 0.5rem 0" }}>
                    {createForm.options.map((opt, idx) => (
                      <li
                        key={idx}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "0.35rem 0.5rem",
                          marginBottom: "0.25rem",
                          background: "var(--color-surface, #fff)",
                          border: "1px solid var(--color-border, #ddd)",
                          borderRadius: "4px",
                          fontSize: "0.85rem",
                        }}
                      >
                        <span>{opt}</span>
                        <button
                          type="button"
                          onClick={() => removeOptionCreate(idx)}
                          title="Remove option"
                          style={{
                            border: "none",
                            background: "transparent",
                            color: "#ef4444",
                            cursor: "pointer",
                            fontWeight: "bold",
                            fontSize: "1rem",
                            lineHeight: 1,
                          }}
                        >
                          &times;
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                  <Input
                    value={newOptionTextCreate}
                    onChange={(e) => setNewOptionTextCreate(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addOptionCreate();
                      }
                    }}
                    placeholder="Add option (e.g. Yes)"
                    inputSize="sm"
                    style={{ flex: "1 1 180px" }}
                  />
                  <button
                    type="button"
                    onClick={addOptionCreate}
                    className="admin-button"
                    style={{ padding: "0.4rem 0.75rem", fontSize: "0.85rem", whiteSpace: "nowrap" }}
                  >
                    + Add option
                  </button>
                </div>
              </div>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <Checkbox
                id="create-required-checkbox"
                checked={createForm.required}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, required: e.target.checked }))}
                label="Required by default"
              />
            </div>

            {createError && <p role="alert" className="form-error" style={{ margin: 0 }}>{createError}</p>}

            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.25rem", flexWrap: "wrap" }}>
              <button type="submit" className="admin-button admin-button--primary">
                Create Field
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

      {/* Records List Panel */}
      <div className="admin-panel" style={{ padding: "0.5rem 1.25rem" }}>
        {loading ? (
          <p className="muted" style={{ padding: "1rem 0" }}>Loading demographic fields…</p>
        ) : items.length === 0 && !isAdding ? (
          <div style={{ padding: "2rem 0", textAlign: "center" }}>
            <p className="muted" style={{ marginBottom: "0.75rem" }}>No demographic fields yet.</p>
            <button type="button" onClick={startAdding} className="admin-button admin-button--primary">
              + Add your first demographic field
            </button>
          </div>
        ) : (
          <ul className="record-list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {items.map((item) => {
              const isMandatory = item.key === "normal_hearing";
              const isPredefined = PREDEFINED_KEYS.has(item.key);
              const isEditing = editingId === item.id;
              const isChoiceType = editForm.fieldType === "select" || editForm.fieldType === "radio";

              if (isEditing) {
                return (
                  <li
                    key={item.id}
                    style={{
                      padding: "1.25rem",
                      margin: "0.85rem -0.5rem",
                      background: "var(--color-surface, #ffffff)",
                      border: "2px solid var(--color-primary, #4f46e5)",
                      borderRadius: "var(--radius-sm, 6px)",
                      boxShadow: "0 2px 10px rgba(79, 70, 229, 0.08)",
                    }}
                  >
                    <form onSubmit={(e) => handleSaveEdit(e, item.id)}>
                      <h2 style={{ fontSize: "1.05rem", margin: "0 0 0.75rem 0", color: "var(--color-foreground)" }}>
                        Edit field: {item.label}
                      </h2>

                      <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
                        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontWeight: 600, fontSize: "0.9rem" }}>
                          Name (Label)
                          <Input
                            value={editForm.label}
                            onChange={(e) => setEditForm((prev) => ({ ...prev, label: e.target.value }))}
                            placeholder="e.g. Age range"
                            autoFocus
                            required
                          />
                        </label>

                        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontWeight: 600, fontSize: "0.9rem" }}>
                          Key {isPredefined && <span className="muted" style={{ fontWeight: 400, fontSize: "0.8rem" }}>(predefined key cannot be changed)</span>}
                          <Input
                            value={editForm.key}
                            onChange={(e) => setEditForm((prev) => ({ ...prev, key: e.target.value }))}
                            disabled={isPredefined}
                          />
                        </label>

                        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontWeight: 600, fontSize: "0.9rem" }}>
                          Field Type
                          <Select
                            value={editForm.fieldType}
                            onChange={(e) => setEditForm((prev) => ({ ...prev, fieldType: e.target.value }))}
                            disabled={isPredefined}
                          >
                            <option value="text">Text (Short Text)</option>
                            <option value="number">Number (Numeric Input)</option>
                            <option value="select">Select (Dropdown)</option>
                            <option value="radio">Radio Buttons</option>
                          </Select>
                        </label>

                        {isChoiceType && (
                          <div
                            style={{
                              padding: "0.75rem",
                              borderRadius: "var(--radius-sm, 6px)",
                              border: "1px solid var(--color-border, #e5e7eb)",
                              background: "var(--color-surface-soft, #f9fafb)",
                            }}
                          >
                            <label style={{ fontWeight: 600, fontSize: "0.85rem", display: "block", marginBottom: "0.4rem" }}>
                              Answer Options
                            </label>

                            {editForm.options.length === 0 ? (
                              <p className="muted" style={{ fontSize: "0.8rem", margin: "0.25rem 0 0.5rem 0" }}>
                                No answer options yet.
                              </p>
                            ) : (
                              <ul style={{ listStyle: "none", padding: 0, margin: "0 0 0.5rem 0" }}>
                                {editForm.options.map((opt, idx) => (
                                  <li
                                    key={idx}
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "space-between",
                                      padding: "0.35rem 0.5rem",
                                      marginBottom: "0.25rem",
                                      background: "var(--color-surface, #fff)",
                                      border: "1px solid var(--color-border, #ddd)",
                                      borderRadius: "4px",
                                      fontSize: "0.85rem",
                                    }}
                                  >
                                    <span>{opt}</span>
                                    {!isPredefined && (
                                      <button
                                        type="button"
                                        onClick={() => removeOptionEdit(idx)}
                                        title="Remove option"
                                        style={{
                                          border: "none",
                                          background: "transparent",
                                          color: "#ef4444",
                                          cursor: "pointer",
                                          fontWeight: "bold",
                                          fontSize: "1rem",
                                          lineHeight: 1,
                                        }}
                                      >
                                        &times;
                                      </button>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            )}

                            {!isPredefined && (
                              <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                                <Input
                                  value={newOptionTextEdit}
                                  onChange={(e) => setNewOptionTextEdit(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      addOptionEdit();
                                    }
                                  }}
                                  placeholder="Add option (e.g. Yes)"
                                  inputSize="sm"
                                  style={{ flex: "1 1 180px" }}
                                />
                                <button
                                  type="button"
                                  onClick={addOptionEdit}
                                  className="admin-button"
                                  style={{ padding: "0.4rem 0.75rem", fontSize: "0.85rem", whiteSpace: "nowrap" }}
                                >
                                  + Add option
                                </button>
                              </div>
                            )}
                          </div>
                        )}

                        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                          <Checkbox
                            id="edit-required-checkbox"
                            checked={isMandatory ? true : editForm.required}
                            onChange={(e) => setEditForm((prev) => ({ ...prev, required: e.target.checked }))}
                            disabled={isMandatory}
                            label={isMandatory ? "Required (mandatory field)" : "Required by default"}
                          />
                        </div>

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
                            Close
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
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                      <strong style={{ fontSize: "0.95rem" }}>{item.label}</strong>
                      {isPredefined && (
                        <span
                          style={{
                            padding: "0.1rem 0.4rem",
                            borderRadius: "4px",
                            background: "#f1f5f9",
                            color: "#475569",
                            fontSize: "0.72rem",
                            fontWeight: 600,
                          }}
                        >
                          Predefined
                        </span>
                      )}
                      {isMandatory && (
                        <span
                          style={{
                            padding: "0.1rem 0.4rem",
                            borderRadius: "4px",
                            background: "#e0e7ff",
                            color: "#3730a3",
                            fontSize: "0.72rem",
                            fontWeight: 600,
                          }}
                        >
                          Mandatory
                        </span>
                      )}
                    </div>

                    <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.15rem" }}>
                      <code>{item.key}</code> • {item.field_type || "text"}
                      {(item.required || item.key === "normal_hearing") ? " • required" : ""}
                    </div>

                    {Array.isArray(item.options) && item.options.length > 0 && (
                      <div style={{ fontSize: "0.75rem", color: "#4b5563", marginTop: "0.2rem" }}>
                        Options: {item.options.join(", ")}
                      </div>
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
                    {!isPredefined && (
                      <button
                        type="button"
                        onClick={() => void handleDelete(item)}
                        title="Delete record"
                        className="admin-button admin-button--sm admin-button--danger"
                      >
                        Delete
                      </button>
                    )}
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
