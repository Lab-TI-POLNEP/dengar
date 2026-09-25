"use client";

import { useEffect, useMemo, useState } from "react";
import { adminRequest, getCsrfToken } from "@/lib/admin-api";
import Select from "@/components/Select";
import { Pagination } from "@/components/Pagination";

type Test = {
  id: number;
  name: string;
  version: number;
  status: string;
};

type EngineStat = {
  engine_id: number;
  engine_name: string;
  mos_n: number;
  mos_mean: number | null;
  mos_stddev: number;
  sus_n: number;
  sus_wacc_mean: number | null;
};

type StimulusStat = {
  id: number;
  neutral_label: string;
  kind: string;
  engine_id: number;
  engine_name: string;
  audio_ref: string;
  stats: {
    n: number;
    mean?: number | null;
    stddev?: number;
    wacc_mean?: number | null;
  };
};

type RespondentResponse = {
  stimulus_id: number;
  neutral_label: string;
  kind: string;
  rating?: number;
  raw_transcription?: string;
  normalized_transcription?: string;
  wacc?: number;
  substitutions?: number;
  deletions?: number;
  insertions?: number;
  play_count: number;
};

type RespondentSession = {
  id: number;
  token_anonymized: string;
  status: string;
  created_at: string | null;
  completed_at: string | null;
  duration_seconds: number | null;
  demographics: Record<string, string>;
  responses: RespondentResponse[];
};

type TestResults = {
  summary: {
    sessions_started: number;
    sessions_completed: number;
    mos: {
      n: number;
      mean: number | null;
      ci95: { lower: number; upper: number } | null;
    };
    sus: {
      n: number;
      wacc_mean: number | null;
    };
  };
  engines: EngineStat[];
  stimuli: StimulusStat[];
  respondents: RespondentSession[];
};

export default function ResultsPage() {
  const [tests, setTests] = useState<Test[]>([]);
  const [selectedTestId, setSelectedTestId] = useState<number | "">("");
  const [results, setResults] = useState<TestResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [defaultPageSize, setDefaultPageSize] = useState<number | null>(null);
  const [pageSize, setPageSize] = useState<number | null>(null);

  const effectivePageSize = pageSize ?? defaultPageSize ?? 5;
  const pageSizeOptions = useMemo(() => {
    const base = [5, 10, 20, 50];
    if (defaultPageSize && !base.includes(defaultPageSize)) {
      return [...base, defaultPageSize].sort((a, b) => a - b);
    }
    return base;
  }, [defaultPageSize]);

  const totalPages = results ? Math.ceil(results.respondents.length / effectivePageSize) || 1 : 1;
  const activePage = Math.max(1, Math.min(currentPage, totalPages));
  const paginatedRespondents = results ? results.respondents.slice((activePage - 1) * effectivePageSize, (activePage - 1) * effectivePageSize + effectivePageSize) : [];
  const susBreakdown = results?.respondents
    .filter((session) => session.status === "completed")
    .flatMap((session) => session.responses)
    .filter((response) => response.kind === "sus")
    .reduce(
      (totals, response) => ({
        substitutions: totals.substitutions + (response.substitutions ?? 0),
        deletions: totals.deletions + (response.deletions ?? 0),
        insertions: totals.insertions + (response.insertions ?? 0),
      }),
      { substitutions: 0, deletions: 0, insertions: 0 },
    ) ?? { substitutions: 0, deletions: 0, insertions: 0 };

  useEffect(() => {
    async function loadSettings() {
      try {
        const response = await adminRequest("/admin/api/settings");
        if (response.ok) {
          const payload = (await response.json()) as { default_page_size?: number };
          if (typeof payload.default_page_size === "number") {
            setDefaultPageSize(payload.default_page_size);
          }
        }
      } catch {
        // Ignore settings failure and keep the local default fallback.
      }
    }

    async function loadTests() {
      try {
        const response = await adminRequest("/admin/api/tests");
        if (response.status === 401) {
          window.location.href = "/admin/signin";
          return;
        }
        if (response.ok) {
          const contentType = response.headers?.get?.("content-type") ?? "";
          if (contentType && !contentType.includes("application/json")) {
            setError("Server returned non-JSON response. Please verify that the backend API is running.");
            return;
          }
          const payload = (await response.json()) as { items: Test[] };
          setTests(payload.items);
        } else {
          setError(`Failed to load tests list (HTTP ${response.status}).`);
        }
      } catch {
        setError("Could not connect to backend server.");
      }
    }
    void loadSettings();
    void loadTests();
  }, []);

  async function loadResults(testId: number) {
    setLoading(true);
    setError("");
    try {
      const response = await adminRequest(`/admin/api/tests/${testId}/results`);
      if (response.ok) {
        const data = (await response.json()) as TestResults;
        setResults(data);
      } else {
        setError("Failed to load results for this test.");
      }
    } catch {
      setError("An error occurred while loading results.");
    } finally {
      setLoading(false);
    }
  }

  function handleTestChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value;
    if (val === "") {
      setSelectedTestId("");
      setResults(null);
      setCurrentPage(1);
    } else {
      const id = parseInt(val, 10);
      setSelectedTestId(id);
      setCurrentPage(1);
      void loadResults(id);
    }
  }

  async function handleExport() {
    if (!selectedTestId) return;
    setExporting(true);
    try {
      const response = await adminRequest(`/admin/api/tests/${selectedTestId}/results/export`);
      if (!response.ok) {
        alert("Could not export the results CSV.");
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `results-test-${selectedTestId}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      alert("Network error during CSV export.");
    } finally {
      setExporting(false);
    }
  }

  async function handleDeleteSession(sessionId: number) {
    if (!window.confirm(`Delete respondent session #${sessionId}? This cannot be undone.`)) return;
    setError("");
    try {
      const csrf = await getCsrfToken();
      const response = await adminRequest(`/admin/api/tests/${selectedTestId}/sessions/${sessionId}`, {
        method: "DELETE",
        headers: { "X-CSRF-Token": csrf },
      });
      if (response.ok) {
        if (selectedTestId) {
          void loadResults(selectedTestId);
        }
      } else {
        setError("Failed to delete respondent session.");
      }
    } catch {
      setError("An error occurred while deleting the session.");
    }
  }

  function formatDuration(seconds: number | null): string {
    if (seconds === null) return "-";
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
  }

  function formatTimestamp(timestamp: string | null): string {
    if (!timestamp) return "-";
    const [datePart, timePart] = timestamp.split("T");
    if (!datePart || !timePart) return timestamp;
    const [year, month, day] = datePart.split("-");
    const [hour, minute] = timePart.split(":");
    return `${year}-${month}-${day} ${hour}:${minute}`;
  }

  return (
    <section className="admin-page">
      <header style={{ marginBottom: "2rem" }}>
        <p className="eyebrow">Studies</p>
        <h1>Results</h1>
        <p className="admin-lede">View session counts, MOS summaries, and SUS scoring.</p>
      </header>

      {/* Test Selector */}
      <div className="admin-panel" style={{ marginBottom: "2rem" }}>
        <label htmlFor="test-select" style={{ fontWeight: "700", display: "block", marginBottom: "0.5rem" }}>
          Select Test Study
        </label>
        <Select
          id="test-select"
          value={selectedTestId}
          onChange={handleTestChange}
          style={{
            maxWidth: "400px",
          }}
        >
          <option value="">-- Choose a test --</option>
          {tests.map((test) => (
            <option key={test.id} value={test.id}>
              {test.name} ({test.status})
            </option>
          ))}
        </Select>
      </div>

      {loading && <p className="muted">Loading results...</p>}
      {error && <p className="form-error" style={{ color: "#a3352b" }}>{error}</p>}

      {!loading && !error && selectedTestId && results && (
        <>
          {results.summary.sessions_started === 0 ? (
            <div className="admin-empty">
              <strong>No results yet</strong>
              <span className="muted">
                Completed respondent sessions will appear here once respondents participate.
              </span>
            </div>
          ) : (
            <div>
              {/* Header Actions */}
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1.5rem" }}>
                <button
                  type="button"
                  onClick={handleExport}
                  disabled={exporting}
                  className="admin-button admin-button--primary"
                  style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
                >
                  <svg
                    style={{ width: "1.15rem", height: "1.15rem" }}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  {exporting ? "Exporting..." : "Export CSV"}
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1rem", marginBottom: "2rem" }}>
                <div className="admin-panel" style={{ textAlign: "center" }}>
                  <span className="muted" style={{ fontSize: "var(--text-xs)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    Sessions Started
                  </span>
                  <div style={{ fontSize: "2.5rem", fontWeight: "800", color: "var(--color-text)" }}>
                    {results.summary.sessions_started}
                  </div>
                </div>
                <div className="admin-panel" style={{ textAlign: "center" }}>
                  <span className="muted" style={{ fontSize: "var(--text-xs)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    Sessions Completed
                  </span>
                  <div style={{ fontSize: "2.5rem", fontWeight: "800", color: "var(--color-primary)" }}>
                    {results.summary.sessions_completed}
                  </div>
                </div>
                <div className="admin-panel" style={{ textAlign: "center" }}>
                  <span className="muted" style={{ fontSize: "var(--text-xs)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    MOS Mean (n={results.summary.mos.n})
                  </span>
                  <div style={{ fontSize: "2rem", fontWeight: "800", color: "var(--color-text)" }}>
                    {results.summary.mos.mean !== null ? results.summary.mos.mean.toFixed(2) : "-"}
                  </div>
                  <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
                    {results.summary.mos.ci95
                      ? `95% CI ${results.summary.mos.ci95.lower.toFixed(2)} to ${results.summary.mos.ci95.upper.toFixed(2)}`
                      : "95% CI unavailable: at least 2 ratings required"}
                  </span>
                </div>
                <div className="admin-panel" style={{ textAlign: "center" }}>
                  <span className="muted" style={{ fontSize: "var(--text-xs)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    SUS WAcc (n={results.summary.sus.n})
                  </span>
                  <div style={{ fontSize: "2rem", fontWeight: "800", color: "var(--color-primary)" }}>
                    {results.summary.sus.wacc_mean !== null ? `${(results.summary.sus.wacc_mean * 100).toFixed(1)}%` : "-"}
                  </div>
                  <span className="muted" style={{ fontSize: "var(--text-sm)" }}>Word accuracy</span>
                </div>
              </div>

              {results.summary.mos.n === 1 && (
                <div className="admin-empty" style={{ marginTop: 0, marginBottom: "2rem" }} role="status">
                  <strong>MOS confidence interval unavailable</strong>
                  <span className="muted">Only one rating is available. Collect at least two ratings before interpreting uncertainty.</span>
                </div>
              )}

              <div className="admin-panel" style={{ marginBottom: "2rem" }}>
                <h2 style={{ marginBottom: "1rem" }}>SUS Error Breakdown</h2>
                {results.summary.sus.n === 0 ? (
                  <p className="muted">No completed SUS responses have a score yet.</p>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "1rem", textAlign: "center" }}>
                    <div><strong style={{ display: "block", fontSize: "1.75rem" }}>{susBreakdown.substitutions}</strong><span className="muted">Substitutions</span></div>
                    <div><strong style={{ display: "block", fontSize: "1.75rem" }}>{susBreakdown.deletions}</strong><span className="muted">Deletions</span></div>
                    <div><strong style={{ display: "block", fontSize: "1.75rem" }}>{susBreakdown.insertions}</strong><span className="muted">Insertions</span></div>
                  </div>
                )}
              </div>

              {/* Engine Table */}
              <div className="admin-panel" style={{ marginBottom: "2rem" }}>
                <h2 style={{ marginBottom: "1rem" }}>Engine Performance Summary</h2>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
                    <thead>
                      <tr style={{ borderBottom: "2px solid var(--color-border)" }}>
                        <th style={{ padding: "0.75rem 0.5rem", fontWeight: "700" }}>Engine Name</th>
                        <th style={{ padding: "0.75rem 0.5rem", fontWeight: "700" }}>MOS (Mean ± SD)</th>
                        <th style={{ padding: "0.75rem 0.5rem", fontWeight: "700" }}>SUS (Mean WAcc %)</th>
                        <th style={{ padding: "0.75rem 0.5rem", fontWeight: "700" }}>Sessions (n)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.engines.map((eng) => (
                        <tr key={eng.engine_id} style={{ borderBottom: "1px solid var(--color-border)" }}>
                          <td style={{ padding: "0.75rem 0.5rem" }}>{eng.engine_name}</td>
                          <td style={{ padding: "0.75rem 0.5rem" }}>
                            {eng.mos_mean !== null
                              ? `${eng.mos_mean.toFixed(2)} ± ${eng.mos_stddev.toFixed(2)}`
                              : "-"}
                          </td>
                          <td style={{ padding: "0.75rem 0.5rem" }}>
                            {eng.sus_wacc_mean !== null
                              ? `${(eng.sus_wacc_mean * 100).toFixed(1)}%`
                              : "-"}
                          </td>
                          <td style={{ padding: "0.75rem 0.5rem" }}>
                            {Math.max(eng.mos_n, eng.sus_n)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Stimulus Drill-down */}
              <div className="admin-panel" style={{ marginBottom: "2rem" }}>
                <h2 style={{ marginBottom: "1rem" }}>Stimulus Performance Detail</h2>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
                    <thead>
                      <tr style={{ borderBottom: "2px solid var(--color-border)" }}>
                        <th style={{ padding: "0.75rem 0.5rem", fontWeight: "700" }}>Label</th>
                        <th style={{ padding: "0.75rem 0.5rem", fontWeight: "700" }}>Kind</th>
                        <th style={{ padding: "0.75rem 0.5rem", fontWeight: "700" }}>Engine</th>
                        <th style={{ padding: "0.75rem 0.5rem", fontWeight: "700" }}>Audio Ref</th>
                        <th style={{ padding: "0.75rem 0.5rem", fontWeight: "700" }}>Performance</th>
                        <th style={{ padding: "0.75rem 0.5rem", fontWeight: "700" }}>Samples (n)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.stimuli.map((stim) => {
                        let perfStr = "-";
                        if (stim.kind === "mos" && stim.stats.mean !== undefined && stim.stats.mean !== null) {
                          perfStr = `${stim.stats.mean.toFixed(2)} ± ${stim.stats.stddev?.toFixed(2)}`;
                        } else if (stim.kind === "sus" && stim.stats.wacc_mean !== undefined && stim.stats.wacc_mean !== null) {
                          perfStr = `${(stim.stats.wacc_mean * 100).toFixed(1)}% WAcc`;
                        }
                        return (
                          <tr key={stim.id} style={{ borderBottom: "1px solid var(--color-border)" }}>
                            <td style={{ padding: "0.75rem 0.5rem", fontWeight: "700" }}>{stim.neutral_label}</td>
                            <td style={{ padding: "0.75rem 0.5rem", textTransform: "uppercase" }}>{stim.kind}</td>
                            <td style={{ padding: "0.75rem 0.5rem" }}>{stim.engine_name}</td>
                            <td style={{ padding: "0.75rem 0.5rem", fontFamily: "monospace" }}>{stim.audio_ref}</td>
                            <td style={{ padding: "0.75rem 0.5rem" }}>{perfStr}</td>
                            <td style={{ padding: "0.75rem 0.5rem" }}>{stim.stats.n}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Respondent Drill-down */}
              <div className="admin-panel" style={{ marginBottom: "2rem" }}>
                <h2 style={{ marginBottom: "1rem" }}>Respondent Sessions Detail</h2>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
                    <thead>
                      <tr style={{ borderBottom: "2px solid var(--color-border)" }}>
                        <th style={{ padding: "0.75rem 0.5rem", fontWeight: "700" }}>Session ID</th>
                        <th style={{ padding: "0.75rem 0.5rem", fontWeight: "700" }}>Status</th>
                        <th style={{ padding: "0.75rem 0.5rem", fontWeight: "700" }}>Completed</th>
                        <th style={{ padding: "0.75rem 0.5rem", fontWeight: "700" }}>Duration</th>
                        <th style={{ padding: "0.75rem 0.5rem", fontWeight: "700" }}>Demographics</th>
                        <th style={{ padding: "0.75rem 0.5rem", fontWeight: "700" }}>Responses</th>
                        <th style={{ padding: "0.75rem 0.5rem", fontWeight: "700" }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedRespondents.map((sess) => {
                        const demoList = Object.entries(sess.demographics).map(([k, v]) => `${k}: ${v}`);
                        return (
                          <tr key={sess.id} style={{ borderBottom: "1px solid var(--color-border)", verticalAlign: "top" }}>
                            <td style={{ padding: "0.75rem 0.5rem", fontWeight: "700" }}>Session #{sess.id}</td>
                            <td style={{ padding: "0.75rem 0.5rem" }}>
                              <span
                                className={`status-badge status-badge--${
                                  sess.status === "completed" ? "published" : "draft"
                                }`}
                              >
                                {sess.status}
                              </span>
                            </td>
                            <td style={{ padding: "0.75rem 0.5rem" }}>{formatTimestamp(sess.completed_at)}</td>
                            <td style={{ padding: "0.75rem 0.5rem" }}>{formatDuration(sess.duration_seconds)}</td>
                            <td style={{ padding: "0.75rem 0.5rem", fontSize: "0.85rem", maxWidth: "250px" }}>
                              {demoList.length > 0 ? (
                                <ul style={{ paddingLeft: "1.2rem", margin: 0 }}>
                                  {demoList.map((d, i) => (
                                    <li key={i}>{d}</li>
                                  ))}
                                </ul>
                              ) : (
                                <span className="muted">None</span>
                              )}
                            </td>
                            <td style={{ padding: "0.75rem 0.5rem", fontSize: "0.85rem" }}>
                              {sess.responses.length > 0 ? (
                                <div style={{ display: "grid", gap: "0.35rem" }}>
                                  {sess.responses.map((resp, idx) => {
                                    if (resp.kind === "mos") {
                                      return (
                                        <div key={idx}>
                                          <strong>{resp.neutral_label} (MOS):</strong> {resp.rating} stars (plays: {resp.play_count})
                                        </div>
                                      );
                                    } else {
                                      return (
                                        <div key={idx}>
                                          <strong>{resp.neutral_label} (SUS):</strong> &ldquo;{resp.raw_transcription}&rdquo; (WAcc: {resp.wacc !== undefined ? `${(resp.wacc * 100).toFixed(1)}%` : "-"}, plays: {resp.play_count})
                                        </div>
                                      );
                                    }
                                  })}
                                </div>
                              ) : (
                                <span className="muted">No responses</span>
                              )}
                            </td>
                            <td style={{ padding: "0.75rem 0.5rem" }}>
                              <button
                                type="button"
                                onClick={() => handleDeleteSession(sess.id)}
                                className="admin-button admin-button--sm admin-button--danger"
                              >
                                Delete
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {results.respondents.length > 0 && (
                  <div className="pagination-wrapper">
                    <Pagination
                      ariaLabel="Respondent sessions pages"
                      currentPage={activePage}
                      totalPages={totalPages}
                      totalItems={results.respondents.length}
                      pageSize={effectivePageSize}
                      pageSizeOptions={pageSizeOptions}
                      onPageChange={(newPage) => setCurrentPage(newPage)}
                      onPageSizeChange={(newSize) => {
                        setPageSize(newSize);
                        setCurrentPage(1);
                      }}
                      itemLabel="sessions"
                      showPageJumper={totalPages > 4}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
