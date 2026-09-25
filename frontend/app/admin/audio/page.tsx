"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { adminRequest, getCsrfToken } from "@/lib/admin-api";
import Input from "@/components/Input";
import Select from "@/components/Select";
import Textarea from "@/components/Textarea";
import Pagination from "@/components/Pagination";

type AudioAssetItem = {
  id: string;
  original_filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  reference_transcription?: string | null;
  engine_id?: number | null;
  status: string;
  created_at: string | null;
};

const backendOrigin = process.env.NEXT_PUBLIC_BACKEND_ORIGIN ?? "";

function streamUrl(id: string): string {
  return `${backendOrigin}/admin/api/audio/${id}/stream`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function describeFailure(cause: unknown): string {
  return cause instanceof Error ? cause.message : "unexpected network error";
}

export default function AudioLibraryPage() {
  const [items, setItems] = useState<AudioAssetItem[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [transcriptions, setTranscriptions] = useState<Record<string, string>>({});
  const [savedTranscriptions, setSavedTranscriptions] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [transcriptionFilter, setTranscriptionFilter] = useState<"all" | "missing" | "ready">("all");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [engines, setEngines] = useState<Array<{ id: number; name: string }>>([]);
  const [defaultPageSize, setDefaultPageSize] = useState<number | null>(null);
  const [pageSize, setPageSize] = useState<number | null>(null);
  const [engineSelections, setEngineSelections] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectedFileRef = useRef<File | null>(null);
  const loadRequestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    try {
      const response = await adminRequest("/admin/api/audio");
      if (response.status === 401) {
        window.location.href = "/admin/signin";
        return;
      }
      if (!response.ok) {
        setError(`Could not load audio assets (HTTP ${response.status}).`);
        return;
      }
      const contentType = response.headers?.get?.("content-type") ?? "";
      if (contentType && !contentType.includes("application/json")) {
        setError("Server returned an unexpected non-JSON response. Please check if the backend service is running correctly.");
        return;
      }
      const payload = (await response.json()) as { items: AudioAssetItem[] };
      if (requestId !== loadRequestRef.current) return;
      setItems(payload.items);
      setEngineSelections(
        Object.fromEntries(
          payload.items.map((item) => [
            item.id,
            item.engine_id !== null && item.engine_id !== undefined ? String(item.engine_id) : "",
          ])
        )
      );
      setSelectedId((current) =>
        current && payload.items.some((item) => item.id === current) ? current : null
      );
      const loadedTranscriptions = payload.items.reduce<Record<string, string>>((map, item) => {
        map[item.id] = item.reference_transcription ?? "";
        return map;
      }, {});
      setTranscriptions(loadedTranscriptions);
      setSavedTranscriptions(loadedTranscriptions);
      setError("");
    } catch (cause) {
      setError(`Could not reach the backend: ${describeFailure(cause)}. Is it running?`);
    } finally {
      setLoading(false);
    }
  }, []);

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
    void adminRequest("/admin/api/engines")
      .then(async (response) => {
        const contentType = response.headers?.get?.("content-type") ?? "";
        if (response.ok && (!contentType || contentType.includes("application/json"))) {
          setEngines(
            ((await response.json()) as { items?: Array<{ id: number; name: string }> }).items ?? []
          );
        }
      })
      .catch(() => setEngines([]));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredItems = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return items.filter((item) => {
      const transcription = savedTranscriptions[item.id] ?? item.reference_transcription ?? "";
      const matchesSearch =
        !normalizedSearch ||
        [item.original_filename, item.id, transcription].some((value) =>
          value.toLowerCase().includes(normalizedSearch)
        );
      const hasTranscription = Boolean(transcription.trim());
      const matchesFilter =
        transcriptionFilter === "all" ||
        (transcriptionFilter === "ready" && hasTranscription) ||
        (transcriptionFilter === "missing" && !hasTranscription);
      return matchesSearch && matchesFilter;
    });
  }, [items, savedTranscriptions, search, transcriptionFilter]);

  const effectivePageSize = pageSize ?? defaultPageSize ?? 20;
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / effectivePageSize));
  const visibleItems = filteredItems.slice((page - 1) * effectivePageSize, page * effectivePageSize);

  const pageSizeOptions = useMemo(() => {
    const options = new Set([5, 10, 20, 50]);
    if (effectivePageSize) options.add(effectivePageSize);
    return Array.from(options).sort((a, b) => a - b);
  }, [effectivePageSize]);

  useEffect(() => {
    setPage((current) => Math.min(Math.max(1, current), pageCount));
  }, [pageCount]);

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const fileToUpload = selectedFileRef.current ?? file;
    if (!fileToUpload) return;
    setUploading(true);
    setError("");
    try {
      const csrf = await getCsrfToken();
      const formData = new FormData();
      formData.append("file", fileToUpload);
      const response = await adminRequest("/admin/api/audio", {
        method: "POST",
        headers: { "X-CSRF-Token": csrf },
        body: formData,
      });
      if (response.status === 401) {
        window.location.href = "/admin/signin";
        return;
      }
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? `Upload failed (HTTP ${response.status}).`);
        return;
      }
      setFile(null);
      selectedFileRef.current = null;
      formElement.reset();
      void load();
    } catch (cause) {
      setError(`Upload failed: ${describeFailure(cause)}. Check that the backend is running.`);
    } finally {
      setUploading(false);
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.target.files?.[0] ?? null;
    setFile(selectedFile);
    selectedFileRef.current = selectedFile;
    if (selectedFile) event.currentTarget.form?.requestSubmit();
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this asset? The file stays on disk (soft delete).")) return;
    setError("");
    try {
      const csrf = await getCsrfToken();
      const response = await adminRequest(`/admin/api/audio/${id}`, {
        method: "DELETE",
        headers: { "X-CSRF-Token": csrf },
      });
      if (!response.ok) {
        setError(`Delete failed (HTTP ${response.status}).`);
        return;
      }
      void load();
    } catch (cause) {
      setError(`Delete failed: ${describeFailure(cause)}.`);
    }
  }

  async function handleSaveAsset(id: string) {
    setError("");
    setSavingId(id);
    try {
      const csrf = await getCsrfToken();
      const currentSelectedEngine = engineSelections[id];
      const fallbackItemEngine = items.find((item) => item.id === id)?.engine_id;
      const rawEngineVal =
        currentSelectedEngine !== undefined
          ? currentSelectedEngine
          : fallbackItemEngine !== null && fallbackItemEngine !== undefined
          ? String(fallbackItemEngine)
          : "";
      const engineIdToSend = rawEngineVal.trim() !== "" ? Number(rawEngineVal) : null;
      const transcriptionToSend = transcriptions[id] ?? "";

      const response = await adminRequest(`/admin/api/audio/${id}`, {
        method: "PATCH",
        headers: { "X-CSRF-Token": csrf },
        body: JSON.stringify({
          engine_id: engineIdToSend,
          reference_transcription: transcriptionToSend,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? `Could not save asset (HTTP ${response.status}).`);
        return;
      }
      const updated = (await response.json()) as AudioAssetItem;
      setSavedTranscriptions((current) => ({
        ...current,
        [id]: updated.reference_transcription ?? transcriptionToSend,
      }));
      setEngineSelections((current) => ({
        ...current,
        [id]:
          updated.engine_id !== null && updated.engine_id !== undefined
            ? String(updated.engine_id)
            : "",
      }));
      setItems((current) =>
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                ...updated,
                engine_id: updated.engine_id ?? null,
                reference_transcription: updated.reference_transcription ?? "",
              }
            : item
        )
      );
        await load();
    } catch (cause) {
      setError(`Could not save asset: ${describeFailure(cause)}.`);
    } finally {
      setSavingId(null);
    }
  }

  function handleCancel(id: string) {
    const item = items.find((entry) => entry.id === id);
    if (item) {
      setTranscriptions((current) => ({
        ...current,
        [id]: savedTranscriptions[id] ?? item.reference_transcription ?? "",
      }));
      setEngineSelections((current) => ({
        ...current,
        [id]: item.engine_id !== null && item.engine_id !== undefined ? String(item.engine_id) : "",
      }));
    }
    setSelectedId(null);
  }

  function handleAudioError(filename: string) {
    setError(`Could not play ${filename}. The audio stream failed or is unavailable.`);
  }

  return (
    <section className="admin-page tests-page">
      <header className="tests-page__header">
        <div className="tests-page__title">
          <p className="eyebrow">Configuration</p>
          <h1>Audio Library</h1>
          <p className="admin-lede">Upload, preview, and manage audio assets.</p>
        </div>
        <div className="audio-upload">
          <form onSubmit={handleUpload}>
            <input
              aria-label="Audio file"
              ref={fileInputRef}
              type="file"
              accept=".wav,.mp3,.ogg,.flac,.m4a"
              onChange={handleFileChange}
              style={{ display: "none" }}
            />
            <button
              aria-label="Upload"
              type="button"
              className="admin-button admin-button--primary"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? "Uploading..." : "Upload audio"}
            </button>
          </form>
          {uploading ? (
            <div className="audio-upload__progress" role="status" aria-live="polite">
              <span>Uploading {file?.name ?? "audio file"}...</span>
              <progress aria-label="Upload progress" />
            </div>
          ) : (
            <span className="muted audio-upload__hint">Allowed: .wav, .mp3, .ogg, .flac, .m4a</span>
          )}
        </div>
      </header>
      {error && <p role="alert" className="form-error">{error}</p>}

        <section className="test-library audio-library audio-library--wide" aria-labelledby="audio-library-heading">
          <div className="test-library__header">
            <h2 id="audio-library-heading" style={{ marginBottom: 0 }}>Your audio assets</h2>
            <span className="muted" aria-live="polite">
              {filteredItems.length === items.length ? `Showing ${items.length}` : `${filteredItems.length} matching`}
            </span>
          </div>
          <div className="audio-library__body">
            {items.length > 0 && (
              <div className="audio-library__filters admin-form">
                <label>
                  Search assets
                  <Input
                    type="search"
                    value={search}
                    placeholder="Filename, ID, or transcription"
                    onChange={(event) => { setSearch(event.target.value); setPage(1); }}
                  />
                </label>
                <label>
                  Transcription
                  <Select
                    value={transcriptionFilter}
                    onChange={(event) => { setTranscriptionFilter(event.target.value as typeof transcriptionFilter); setPage(1); }}
                  >
                    <option value="all">All assets</option>
                    <option value="missing">Missing transcription</option>
                    <option value="ready">Ready transcription</option>
                  </Select>
                </label>
              </div>
            )}
            {!error && loading ? (
              <p className="muted">Loading…</p>
            ) : items.length === 0 ? (
              <p className="muted">No audio assets yet. Upload one to begin.</p>
            ) : filteredItems.length === 0 ? (
              <p className="muted">No assets match your search.</p>
            ) : (
            <div className="audio-table">
              <div className="audio-table__header">
                <span className="audio-col--main">Asset / Filename</span>
                <span className="audio-col--engine">Engine</span>
                <span className="audio-col--transcription">Transcription</span>
                <span className="audio-col--actions">Actions</span>
              </div>
              <div className="audio-table__body">
                {visibleItems.map((item) => {
                  const isExpanded = selectedId === item.id;
                  const transcriptionText = (savedTranscriptions[item.id] ?? item.reference_transcription ?? "").trim();
                  const currentEngineVal =
                    engineSelections[item.id] ??
                    (item.engine_id !== null && item.engine_id !== undefined ? String(item.engine_id) : "");
                  const assignedEngine = engines.find((e) => String(e.id) === currentEngineVal);

                  return (
                    <article className={`audio-row ${isExpanded ? "is-expanded" : ""}`} key={item.id}>
                      <div
                        className="audio-row__summary"
                        onClick={() => setSelectedId((current) => (current === item.id ? null : item.id))}
                        role="button"
                        tabIndex={0}
                        aria-expanded={isExpanded}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelectedId((current) => (current === item.id ? null : item.id));
                          }
                        }}
                      >
                        <div className="audio-col--main">
                          <div className="audio-row__icon" aria-hidden="true">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M9 18V5l12-2v13" />
                              <circle cx="6" cy="18" r="3" />
                              <circle cx="18" cy="16" r="3" />
                            </svg>
                          </div>
                          <div className="audio-row__info">
                            <h3 className="audio-row__filename">{item.original_filename}</h3>
                            <span className="audio-row__meta">
                              {formatSize(item.size_bytes)} · {item.content_type}
                            </span>
                          </div>
                        </div>

                        <div className="audio-col--engine">
                          {assignedEngine ? (
                            <span className="audio-engine-tag">{assignedEngine.name}</span>
                          ) : (
                            <span className="audio-engine-tag audio-engine-tag--none">No engine</span>
                          )}
                        </div>

                        <div className="audio-col--transcription">
                          <span className={`status-badge ${transcriptionText ? "status-badge--ready" : "status-badge--missing"}`}>
                            {transcriptionText ? "Ready" : "Missing transcription"}
                          </span>
                          {transcriptionText ? (
                            <span className="audio-row__transcription-snippet" title={transcriptionText}>
                              &ldquo;{transcriptionText}&rdquo;
                            </span>
                          ) : null}
                        </div>

                        <div className="audio-col--actions" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            className="admin-button"
                            aria-expanded={isExpanded}
                            onClick={() => setSelectedId((current) => (current === item.id ? null : item.id))}
                          >
                            {isExpanded ? "Hide" : "View"}
                          </button>
                          <button
                            type="button"
                            className="admin-button admin-button--danger"
                            aria-label="Delete audio"
                            title="Delete audio"
                            onClick={() => handleDelete(item.id)}
                          >                            
                            <span>Delete</span>
                          </button>
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="audio-row__detail-panel">
                          <div className="audio-detail__grid">
                            <div className="audio-detail__media-card">
                              <div className="audio-detail__section-title">
                                <h4>Audio Preview</h4>
                              </div>
                              <div className="audio-detail__player">
                                <audio
                                  controls
                                  preload="none"
                                  src={streamUrl(item.id)}
                                  onError={() => handleAudioError(item.original_filename)}
                                />
                              </div>
                              <div className="audio-detail__meta-list">
                                <div className="audio-detail__meta-item">
                                  <span className="meta-label">Asset ID</span>
                                  <code className="meta-value" title={item.id}>{item.id}</code>
                                </div>
                                <div className="audio-detail__meta-item">
                                  <span className="meta-label">SHA-256 Checksum</span>
                                  <code className="meta-value" title={item.sha256}>sha256 {item.sha256.slice(0, 16)}…</code>
                                </div>
                              </div>
                            </div>

                            <div className="audio-detail__form-card">
                              <div className="audio-detail__section-title">
                                <h4>Asset Settings</h4>
                              </div>
                              <div className="audio-detail__form-fields">
                                <label className="audio-field">
                                  <span className="audio-field__label">Assigned Engine</span>
                                  <Select
                                    aria-label={`Engine for ${item.original_filename}`}
                                    value={
                                      engineSelections[item.id] !== undefined
                                        ? engineSelections[item.id]
                                        : item.engine_id !== null && item.engine_id !== undefined
                                        ? String(item.engine_id)
                                        : ""
                                    }
                                    onChange={(event) =>
                                      setEngineSelections((current) => ({
                                        ...current,
                                        [item.id]: event.target.value,
                                      }))
                                    }
                                  >
                                    <option value="">No engine</option>
                                    {engines.map((engine) => (
                                      <option key={engine.id} value={engine.id}>
                                        {engine.name}
                                      </option>
                                    ))}
                                  </Select>
                                  <span className="audio-field__hint">Assign this recording to a synthesis engine.</span>
                                </label>

                                <label className="audio-field">
                                  <span className="audio-field__label">Reference Transcription</span>
                                  <Textarea
                                    variant="mono"
                                    aria-label={`Reference transcription for ${item.original_filename}`}
                                    value={transcriptions[item.id] ?? ""}
                                    onChange={(event) =>
                                      setTranscriptions((current) => ({
                                        ...current,
                                        [item.id]: event.target.value,
                                      }))
                                    }
                                    placeholder="Enter reference transcription for intelligibility testing..."
                                    rows={3}
                                  />
                                  <span className="audio-field__hint">Used for SUS scoring and validation during tests.</span>
                                </label>
                              </div>
                            </div>
                          </div>

                          <div className="audio-detail__footer">
                            <div className="audio-detail__footer-actions" style={{ marginLeft: "auto" }}>
                              <button
                                type="button"
                                className="admin-button"
                                onClick={() => handleCancel(item.id)}
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                className="admin-button admin-button--primary"
                                disabled={savingId === item.id}
                                onClick={() => handleSaveAsset(item.id)}
                                aria-label="Save"
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                                  <polyline points="17 21 17 13 7 13 7 21" />
                                  <polyline points="7 3 7 8 15 8" />
                                </svg>
                                <span>{savingId === item.id ? "Saving…" : "Save"}</span>
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>
          )}
          </div>
          {filteredItems.length > 0 && (
            <div className="pagination-wrapper audio-pagination-wrapper">
              <Pagination
                ariaLabel="Audio asset pages"
                currentPage={page}
                totalPages={pageCount}
                totalItems={filteredItems.length}
                pageSize={effectivePageSize}
                pageSizeOptions={pageSizeOptions}
                onPageChange={(newPage) => setPage(newPage)}
                onPageSizeChange={(newSize) => {
                  setPageSize(newSize);
                  setPage(1);
                }}
                itemLabel="assets"
                showPageJumper={pageCount > 4}
              />
            </div>
          )}
        </section>
    </section>
  );
}
