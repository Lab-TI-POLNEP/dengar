"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { adminRequest, getCsrfToken } from "@/lib/admin-api";
import Input from "@/components/Input";
import Textarea from "@/components/Textarea";

export interface MOSScalePreset {
  id: number;
  name: string;
  minimum: number;
  maximum: number;
  labels: string[];
  prompt: string;
}

const DEFAULT_LABELS_5 = ["Bad", "Poor", "Fair", "Good", "Excellent"];
const DEFAULT_PROMPT = "Rate the naturalness of the speech on a scale from 1 to 5.";

interface ScaleFormData {
  name: string;
  minimum: number;
  maximum: number;
  labels: string[];
  prompt: string;
}

export default function MOSScalesPage() {
  const [items, setItems] = useState<MOSScalePreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalError, setGlobalError] = useState("");

  // Adding state
  const [isAdding, setIsAdding] = useState(false);
  const [createForm, setCreateForm] = useState<ScaleFormData>({
    name: "",
    minimum: 1,
    maximum: 5,
    labels: DEFAULT_LABELS_5,
    prompt: DEFAULT_PROMPT,
  });
  const [createError, setCreateError] = useState("");

  // Editing state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<ScaleFormData>({
    name: "",
    minimum: 1,
    maximum: 5,
    labels: DEFAULT_LABELS_5,
    prompt: DEFAULT_PROMPT,
  });
  const [editError, setEditError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const response = await adminRequest("/admin/api/mos-scales");
    if (response.status === 401) {
      window.location.href = "/admin/signin";
      return;
    }
    if (response.ok) {
      const payload = (await response.json()) as { items: MOSScalePreset[] };
      setItems(payload.items ?? []);
    } else {
      setGlobalError("Could not load MOS scale presets.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Adjust labels helper when min/max changes
  function updateRange(
    formData: ScaleFormData,
    newMin: number,
    newMax: number
  ): ScaleFormData {
    const updated = { ...formData, minimum: newMin, maximum: newMax };
    if (newMax > newMin) {
      const count = newMax - newMin + 1;
      const nextLabels = [...formData.labels];
      if (nextLabels.length < count) {
        while (nextLabels.length < count) {
          nextLabels.push(`${newMin + nextLabels.length}`);
        }
      } else if (nextLabels.length > count) {
        nextLabels.length = count;
      }
      updated.labels = nextLabels;
    }
    return updated;
  }

  // --- Add actions ---
  function startAdding() {
    setIsAdding(true);
    setCreateForm({
      name: "",
      minimum: 1,
      maximum: 5,
      labels: DEFAULT_LABELS_5,
      prompt: DEFAULT_PROMPT,
    });
    setCreateError("");
    setEditingId(null);
  }

  function cancelAdding() {
    setIsAdding(false);
    setCreateError("");
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setCreateError("");

    const trimmedName = createForm.name.trim();
    if (!trimmedName) {
      setCreateError("Scale name is required.");
      return;
    }

    if (createForm.minimum >= createForm.maximum) {
      setCreateError("Minimum score must be less than maximum score.");
      return;
    }

    const expectedPoints = createForm.maximum - createForm.minimum + 1;
    if (createForm.labels.length !== expectedPoints) {
      setCreateError(`Exactly ${expectedPoints} labels are required.`);
      return;
    }

    if (createForm.labels.some((l) => !l.trim())) {
      setCreateError("All score point labels must be non-empty.");
      return;
    }

    const trimmedPrompt = createForm.prompt.trim();
    if (!trimmedPrompt) {
      setCreateError("Rating prompt / instruction is required.");
      return;
    }

    const csrf = await getCsrfToken();
    const payload = {
      name: trimmedName,
      min: createForm.minimum,
      max: createForm.maximum,
      labels: createForm.labels.map((l) => l.trim()),
      prompt: trimmedPrompt,
    };

    const response = await adminRequest("/admin/api/mos-scales", {
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
        data.errors?.join("; ") || data.error || "Could not create scale preset.";
      setCreateError(errMsg);
      return;
    }

    cancelAdding();
    void load();
  }

  // --- Inline edit actions ---
  function startEdit(item: MOSScalePreset) {
    setEditingId(item.id);
    const minVal = Number(item.minimum) || 1;
    const maxVal = Number(item.maximum) || 5;
    const itemLabels = Array.isArray(item.labels) ? [...item.labels] : [];
    const expectedCount = Math.max(0, maxVal - minVal + 1);
    if (itemLabels.length !== expectedCount) {
      while (itemLabels.length < expectedCount) {
        itemLabels.push(`${minVal + itemLabels.length}`);
      }
    }

    setEditForm({
      name: item.name || "",
      minimum: minVal,
      maximum: maxVal,
      labels: itemLabels,
      prompt: item.prompt || DEFAULT_PROMPT,
    });
    setEditError("");
    setIsAdding(false);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError("");
  }

  async function handleSaveEdit(event: FormEvent, id: number) {
    event.preventDefault();
    setEditError("");

    const trimmedName = editForm.name.trim();
    if (!trimmedName) {
      setEditError("Scale name is required.");
      return;
    }

    if (editForm.minimum >= editForm.maximum) {
      setEditError("Minimum score must be less than maximum score.");
      return;
    }

    const expectedPoints = editForm.maximum - editForm.minimum + 1;
    if (editForm.labels.length !== expectedPoints) {
      setEditError(`Exactly ${expectedPoints} labels are required.`);
      return;
    }

    if (editForm.labels.some((l) => !l.trim())) {
      setEditError("All score point labels must be non-empty.");
      return;
    }

    const trimmedPrompt = editForm.prompt.trim();
    if (!trimmedPrompt) {
      setEditError("Rating prompt / instruction is required.");
      return;
    }

    const csrf = await getCsrfToken();
    const payload = {
      name: trimmedName,
      min: editForm.minimum,
      max: editForm.maximum,
      labels: editForm.labels.map((l) => l.trim()),
      prompt: trimmedPrompt,
    };

    const response = await adminRequest(`/admin/api/mos-scales/${id}`, {
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
        data.errors?.join("; ") || data.error || "Could not update scale preset.";
      setEditError(errMsg);
      return;
    }

    cancelEdit();
    void load();
  }

  async function handleDelete(item: MOSScalePreset) {
    if (!confirm(`Are you sure you want to delete MOS scale preset '${item.name}'?`)) {
      return;
    }
    setGlobalError("");
    const csrf = await getCsrfToken();
    const response = await adminRequest(`/admin/api/mos-scales/${item.id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrf },
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      const msg =
        response.status === 409
          ? `Cannot delete '${item.name}': This scale preset is currently referenced by one or more tests.`
          : data.error || "Could not delete scale preset.";
      setGlobalError(msg);
      return;
    }

    if (editingId === item.id) {
      cancelEdit();
    }
    void load();
  }

  // Render form fields (used in both creation & inline edit modes)
  function renderFormFields(
    data: ScaleFormData,
    setData: (updater: (prev: ScaleFormData) => ScaleFormData) => void,
    errorMsg: string,
    onCancel: () => void,
    submitLabel: string,
    title: string
  ) {
    const pointsCount =
      data.minimum < data.maximum ? data.maximum - data.minimum + 1 : 0;

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <h2 style={{ fontSize: "1.05rem", margin: "0 0 0.25rem 0", color: "var(--color-foreground)" }}>
          {title}
        </h2>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontWeight: 600, fontSize: "0.9rem" }}>
          Scale Name
          <Input
            value={data.name}
            onChange={(e) => setData((prev) => ({ ...prev, name: e.target.value }))}
            placeholder="e.g. Standard 5-Point MOS"
            autoFocus
            required
          />
        </label>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "1rem" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontWeight: 600, fontSize: "0.9rem" }}>
            Minimum score
            <Input
              type="number"
              value={data.minimum}
              onChange={(e) =>
                setData((prev) => updateRange(prev, Number(e.target.value), prev.maximum))
              }
              required
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontWeight: 600, fontSize: "0.9rem" }}>
            Maximum score
            <Input
              type="number"
              value={data.maximum}
              onChange={(e) =>
                setData((prev) => updateRange(prev, prev.minimum, Number(e.target.value)))
              }
              required
            />
          </label>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontWeight: 600, fontSize: "0.9rem" }}>
          Rating Prompt / Instruction
          <Textarea
            value={data.prompt}
            onChange={(e) => setData((prev) => ({ ...prev, prompt: e.target.value }))}
            placeholder="e.g. Rate the naturalness of the speech on a scale from 1 to 5."
            rows={2}
            required
          />
        </label>

        {/* Score point labels */}
        <div
          style={{
            padding: "0.85rem",
            borderRadius: "var(--radius-sm, 6px)",
            border: "1px solid var(--color-border, #e5e7eb)",
            background: "var(--color-surface-soft, #f9fafb)",
          }}
        >
          <label style={{ fontWeight: 600, fontSize: "0.85rem", display: "block", marginBottom: "0.5rem" }}>
            Score Labels ({pointsCount} points)
          </label>

          {data.minimum >= data.maximum ? (
            <p className="muted" style={{ fontSize: "0.85rem", color: "#dc2626", margin: 0 }}>
              Minimum score must be less than maximum score.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
              {Array.from({ length: pointsCount }, (_, idx) => {
                const score = data.minimum + idx;
                return (
                  <div
                    key={score}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        minWidth: "4rem",
                        fontSize: "0.85rem",
                        fontWeight: 700,
                        color: "var(--color-text)",
                      }}
                    >
                      Score {score}:
                    </span>
                    <Input
                      value={data.labels[idx] ?? ""}
                      onChange={(e) =>
                        setData((prev) => {
                          const next = [...prev.labels];
                          next[idx] = e.target.value;
                          return { ...prev, labels: next };
                        })
                      }
                      placeholder={`Label for score ${score}`}
                      inputSize="sm"
                      style={{ flex: "1 1 180px" }}
                      required
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Respondent Preview */}
        {data.minimum < data.maximum && data.labels.length === pointsCount && (
          <div
            style={{
              padding: "0.85rem",
              borderRadius: "var(--radius-sm, 6px)",
              border: "1px dashed var(--color-border, #ccc)",
              background: "var(--color-surface, #fff)",
            }}
          >
            <span className="muted" style={{ fontSize: "0.75rem", textTransform: "uppercase", fontWeight: 700 }}>
              Respondent Preview
            </span>
            <p style={{ fontSize: "0.85rem", fontWeight: 600, margin: "0.35rem 0 0.5rem 0" }}>
              {data.prompt || "Rate the audio:"}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
              {Array.from({ length: pointsCount }, (_, idx) => {
                const score = data.minimum + idx;
                const lbl = data.labels[idx] || "";
                return (
                  <div
                    key={score}
                    style={{
                      flex: "1 1 55px",
                      minWidth: "55px",
                      padding: "0.4rem 0.2rem",
                      border: "1px solid var(--color-border, #ddd)",
                      borderRadius: "6px",
                      textAlign: "center",
                      background: "#fff",
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: "0.95rem" }}>{score}</div>
                    <div style={{ fontSize: "0.7rem", color: "var(--color-muted, #666)" }}>{lbl}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {errorMsg && <p role="alert" className="form-error" style={{ margin: 0 }}>{errorMsg}</p>}

        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.25rem", flexWrap: "wrap" }}>
          <button type="submit" className="admin-button admin-button--primary">
            {submitLabel}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="admin-button"
            style={{ background: "transparent", border: "1px solid var(--color-border)" }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
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
            MOS Scales <span className="count" style={{ fontSize: "1.1rem", verticalAlign: "middle" }}>{items.length}</span>
          </h1>
        </div>

        {!isAdding && (
          <button
            type="button"
            onClick={startAdding}
            className="admin-button admin-button--primary"
            style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
          >
            <span style={{ fontSize: "1.1rem", lineHeight: 1 }}>+</span> Add scale preset
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

      {/* Add New Scale Preset In-Place Form */}
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
          {renderFormFields(
            createForm,
            setCreateForm,
            createError,
            cancelAdding,
            "Create Preset",
            "Add new scale preset"
          )}
        </form>
      )}

      {/* Records List Panel */}
      <div className="admin-panel" style={{ padding: "0.5rem 1.25rem" }}>
        {loading ? (
          <p className="muted" style={{ padding: "1rem 0" }}>Loading MOS scale presets…</p>
        ) : items.length === 0 && !isAdding ? (
          <div style={{ padding: "2rem 0", textAlign: "center" }}>
            <p className="muted" style={{ marginBottom: "0.75rem" }}>No MOS scale presets yet.</p>
            <button type="button" onClick={startAdding} className="admin-button admin-button--primary">
              + Add your first scale preset
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
                      padding: "1.25rem",
                      margin: "0.85rem -0.5rem",
                      background: "var(--color-surface, #ffffff)",
                      border: "2px solid var(--color-primary, #4f46e5)",
                      borderRadius: "var(--radius-sm, 6px)",
                      boxShadow: "0 2px 10px rgba(79, 70, 229, 0.08)",
                    }}
                  >
                    <form onSubmit={(e) => handleSaveEdit(e, item.id)}>
                      {renderFormFields(
                        editForm,
                        setEditForm,
                        editError,
                        cancelEdit,
                        "Save Changes",
                        `Edit scale preset: ${item.name}`
                      )}
                    </form>
                  </li>
                );
              }

              return (
                <li
                  key={item.id}
                  className="record-list__item"
                  style={{ alignItems: "flex-start" }}
                >
                  <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                      <strong style={{ fontSize: "0.95rem" }}>{item.name}</strong>
                      <span
                        style={{
                          fontSize: "0.72rem",
                          padding: "0.15rem 0.45rem",
                          borderRadius: "4px",
                          background: "#e0e7ff",
                          color: "#3730a3",
                          fontWeight: 600,
                        }}
                      >
                        {item.minimum} to {item.maximum} ({item.maximum - item.minimum + 1} pts)
                      </span>
                    </div>

                    <p style={{ fontSize: "0.8rem", color: "var(--color-text)", margin: "0.25rem 0 0.35rem 0" }}>
                      <em>&ldquo;{item.prompt}&rdquo;</em>
                    </p>

                    {Array.isArray(item.labels) && item.labels.length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem" }}>
                        {item.labels.map((lbl, idx) => (
                          <span
                            key={idx}
                            style={{
                              fontSize: "0.7rem",
                              padding: "0.1rem 0.35rem",
                              borderRadius: "4px",
                              background: "var(--color-surface-soft)",
                              color: "var(--color-text)",
                              border: "1px solid var(--color-border)",
                            }}
                          >
                            <strong>{item.minimum + idx}:</strong> {lbl}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="record-list__actions" style={{ alignSelf: "center" }}>
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
                      title="Delete scale preset"
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
