"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminRequest } from "@/lib/admin-api";
import {
  TestTubeIcon,
  MusicIcon,
  BarChartIcon,
  CheckCircleIcon,
  CopyIcon,
  CheckIcon,
  ExternalLinkIcon,
  SparklesIcon,
  ActivityIcon,
  UsersIcon,
  LayersIcon,
  HeadphonesIcon,
  ShieldIcon,
} from "@/components/Icons";

type DashboardMetrics = {
  total_tests: number;
  published_tests: number;
  draft_tests: number;
  total_sessions: number;
  completed_sessions: number;
  active_sessions: number;
  completion_rate: number;
  mos: {
    total_ratings: number;
    mean: number | null;
    ci95: { lower: number; upper: number } | null;
  };
  sus: {
    total_evaluations: number;
    mean_wacc: number | null;
    total_substitutions: number;
    total_deletions: number;
    total_insertions: number;
  };
  audio: {
    total_assets: number;
    total_size_bytes: number;
    engines_covered: number;
  };
  system: {
    offline_mode: boolean;
    database_engine: string;
    storage_healthy: boolean;
  };
};

type ActiveTest = {
  id: number;
  name: string;
  version: number;
  status: string;
  access_code: string | null;
  stimuli_count: number;
  created_at: string | null;
  sessions_started: number;
  sessions_completed: number;
  mos_mean: number | null;
  sus_wacc_mean: number | null;
};

type EngineBenchmark = {
  id: number;
  name: string;
  description: string | null;
  mos_n: number;
  mos_mean: number | null;
  mos_stddev: number | null;
  sus_n: number;
  sus_wacc_mean: number | null;
  stimuli_count: number;
};

type RecentActivity = {
  id: number;
  test_id: number;
  test_name: string;
  status: string;
  created_at: string | null;
  completed_at: string | null;
  duration_seconds: number | null;
  mos_responses_count: number;
  sus_responses_count: number;
};

type ReadinessChecklist = {
  engines: { count: number; ready: boolean };
  mos_scales: { count: number; ready: boolean };
  demographics: { count: number; ready: boolean };
  text_templates: { count: number; ready: boolean };
  audio_assets: { count: number; ready: boolean };
  tests: { count: number; ready: boolean };
  has_published_test: boolean;
};

type DashboardData = {
  metrics: DashboardMetrics;
  active_tests: ActiveTest[];
  engine_benchmarks: EngineBenchmark[];
  recent_activity: RecentActivity[];
  readiness: ReadinessChecklist;
};

function formatBytes(bytes: number | undefined | null): string {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
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
  try {
    const [datePart, timePart] = timestamp.split("T");
    if (!datePart || !timePart) return timestamp;
    const [, month, day] = datePart.split("-");
    const [hour, minute] = timePart.split(":");
    return `${month}/${day} ${hour}:${minute}`;
  } catch {
    return timestamp;
  }
}

export default function AdminDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copiedCodeId, setCopiedCodeId] = useState<number | null>(null);
  const [copiedLinkId, setCopiedLinkId] = useState<number | null>(null);

  async function loadDashboard() {
    setLoading(true);
    setError("");
    try {
      const response = await adminRequest("/admin/api/dashboard");
      if (response.status === 401) {
        window.location.href = "/admin/signin";
        return;
      }
      if (response.ok) {
        const result = (await response.json()) as DashboardData;
        setData(result);
      } else {
        setError("Failed to load dashboard statistics.");
      }
    } catch {
      setError("Network or server connection error.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDashboard();
  }, []);

  async function handleCopyCode(testId: number, code: string) {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCodeId(testId);
      setTimeout(() => setCopiedCodeId(null), 2000);
    } catch {
      // Fallback
    }
  }

  async function handleCopyLink(testId: number, accessCode: string | null) {
    try {
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const url = accessCode
        ? `${origin}/get-started?code=${accessCode}`
        : `${origin}/get-started?test=${testId}`;
      await navigator.clipboard.writeText(url);
      setCopiedLinkId(testId);
      setTimeout(() => setCopiedLinkId(null), 2000);
    } catch {
      // Fallback
    }
  }

  if (loading) {
    return (
      <div className="admin-page dashboard-page">
        <header className="dashboard-header">
          <div className="dashboard-header__title-group">
            <p className="eyebrow">Workspace</p>
            <h1>Dashboard</h1>
            <p className="admin-lede">Speech evaluation analytics & study overview.</p>
          </div>
        </header>
        <div className="dashboard-kpi-grid">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="dashboard-kpi-card" style={{ minHeight: "140px" }}>
              <div className="dashboard-skeleton" style={{ height: "100%", width: "100%" }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="admin-page dashboard-page">
        <header className="dashboard-header">
          <div className="dashboard-header__title-group">
            <p className="eyebrow">Workspace</p>
            <h1>Dashboard</h1>
          </div>
        </header>
        <div className="admin-empty">
          <strong>Could not load dashboard data</strong>
          <span className="muted">{error || "Please check your network and refresh."}</span>
          <button
            type="button"
            onClick={loadDashboard}
            className="admin-button admin-button--primary"
            style={{ marginTop: "1rem", width: "fit-content" }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const { metrics, active_tests, engine_benchmarks, recent_activity, readiness } = data;
  const publishedTests = active_tests.filter((t) => t.status === "published");

  return (
    <div className="admin-page dashboard-page">
      {/* Top Header */}
      <header className="dashboard-header">
        <div className="dashboard-header__title-group">
          <p className="eyebrow">Workspace</p>
          <h1>Dashboard</h1>
          <div className="dashboard-header__meta">
            <p className="admin-lede" style={{ margin: 0 }}>
              Live control and performance metrics for your speech evaluation studies.
            </p>
            <span className="dashboard-status-pill">
              <span className="dashboard-status-pill__dot" />
              Offline Engine Active
            </span>
          </div>
        </div>

        <div className="dashboard-header__actions">
          <Link href="/admin/tests/new" className="admin-button admin-button--primary dashboard-btn-icon">
            <TestTubeIcon />
            New Study
          </Link>
          <Link href="/admin/audio" className="admin-button dashboard-btn-icon">
            <MusicIcon />
            Audio Library
          </Link>
          <Link href="/admin/results" className="admin-button dashboard-btn-icon">
            <BarChartIcon />
            View Results
          </Link>
        </div>
      </header>

      {/* KPI Cards Grid */}
      <section className="dashboard-kpi-grid" aria-label="Key Performance Indicators">
        {/* Card 1: Active Studies */}
        <div className="dashboard-kpi-card dashboard-kpi-card--primary">
          <div className="dashboard-kpi-card__header">
            <span className="dashboard-kpi-card__label">Active Studies</span>
            <div className="dashboard-kpi-card__icon-box">
              <TestTubeIcon />
            </div>
          </div>
          <div className="dashboard-kpi-card__value-row">
            <span className="dashboard-kpi-card__number">{metrics.published_tests}</span>
            <span className="dashboard-kpi-card__unit">published</span>
          </div>
          <div className="dashboard-progress-bar">
            <div
              className="dashboard-progress-fill"
              style={{
                width: `${metrics.total_tests > 0 ? (metrics.published_tests / metrics.total_tests) * 100 : 0}%`,
              }}
            />
          </div>
          <div className="dashboard-kpi-card__footer">
            <span>{metrics.draft_tests} draft study in progress</span>
            <Link href="/admin/tests" className="count">
              Manage →
            </Link>
          </div>
        </div>

        {/* Card 2: Respondent Participation */}
        <div className="dashboard-kpi-card dashboard-kpi-card--success">
          <div className="dashboard-kpi-card__header">
            <span className="dashboard-kpi-card__label">Participation</span>
            <div className="dashboard-kpi-card__icon-box">
              <UsersIcon />
            </div>
          </div>
          <div className="dashboard-kpi-card__value-row">
            <span className="dashboard-kpi-card__number">{metrics.completed_sessions}</span>
            <span className="dashboard-kpi-card__unit">completed</span>
          </div>
          <div className="dashboard-progress-bar">
            <div
              className="dashboard-progress-fill dashboard-progress-fill--success"
              style={{ width: `${Math.min(100, metrics.completion_rate)}%` }}
            />
          </div>
          <div className="dashboard-kpi-card__footer">
            <span>{metrics.completion_rate}% completion rate</span>
            <span>{metrics.total_sessions} total started</span>
          </div>
        </div>

        {/* Card 3: MOS Naturalness */}
        <div className="dashboard-kpi-card dashboard-kpi-card--indigo">
          <div className="dashboard-kpi-card__header">
            <span className="dashboard-kpi-card__label">MOS Naturalness</span>
            <div className="dashboard-kpi-card__icon-box">
              <SparklesIcon />
            </div>
          </div>
          <div className="dashboard-kpi-card__value-row">
            <span className="dashboard-kpi-card__number">
              {metrics.mos.mean !== null ? metrics.mos.mean.toFixed(2) : "—"}
            </span>
            <span className="dashboard-kpi-card__unit">/ 5.00</span>
          </div>
          <div className="dashboard-progress-bar">
            <div
              className="dashboard-progress-fill"
              style={{
                width: `${metrics.mos.mean !== null ? (metrics.mos.mean / 5) * 100 : 0}%`,
                background: "linear-gradient(90deg, #6366f1, #8b5cf6)",
              }}
            />
          </div>
          <div className="dashboard-kpi-card__footer">
            <span>{metrics.mos.total_ratings} ratings collected</span>
            <span>
              {metrics.mos.ci95
                ? `95% CI ±${((metrics.mos.ci95.upper - metrics.mos.ci95.lower) / 2).toFixed(2)}`
                : "Standard 5-point scale"}
            </span>
          </div>
        </div>

        {/* Card 4: SUS Intelligibility */}
        <div className="dashboard-kpi-card dashboard-kpi-card--amber">
          <div className="dashboard-kpi-card__header">
            <span className="dashboard-kpi-card__label">SUS Intelligibility</span>
            <div className="dashboard-kpi-card__icon-box">
              <ActivityIcon />
            </div>
          </div>
          <div className="dashboard-kpi-card__value-row">
            <span className="dashboard-kpi-card__number">
              {metrics.sus.mean_wacc !== null ? `${(metrics.sus.mean_wacc * 100).toFixed(1)}%` : "—"}
            </span>
            <span className="dashboard-kpi-card__unit">WAcc</span>
          </div>
          <div className="dashboard-progress-bar">
            <div
              className="dashboard-progress-fill"
              style={{
                width: `${metrics.sus.mean_wacc !== null ? metrics.sus.mean_wacc * 100 : 0}%`,
                background: "linear-gradient(90deg, #d97706, #f59e0b)",
              }}
            />
          </div>
          <div className="dashboard-kpi-card__footer">
            <span>{metrics.sus.total_evaluations} scored responses</span>
            <span>
              {metrics.sus.total_substitutions + metrics.sus.total_deletions + metrics.sus.total_insertions} total errors
            </span>
          </div>
        </div>
      </section>

      {/* Main Content 2-Column Grid */}
      <div className="dashboard-main-grid">
        {/* Left Column: Studies, Benchmarks & Offline Telemetry */}
        <div className="dashboard-col-left">
          {/* Active / Published Studies Hub */}
          <section className="dashboard-card" aria-labelledby="studies-hub-title">
            <div className="dashboard-card__header">
              <div className="dashboard-card__title-group">
                <TestTubeIcon />
                <h2 id="studies-hub-title">Published Speech Studies</h2>
              </div>
              <Link href="/admin/tests" className="dashboard-card__action-link">
                View all tests ({metrics.total_tests}) →
              </Link>
            </div>
            <div className="dashboard-card__body">
              {publishedTests.length === 0 ? (
                <div className="admin-empty" style={{ margin: 0, textAlign: "center" }}>
                  <strong>No studies published yet</strong>
                  <span className="muted">
                    Create a test configuration with stimuli, then publish it to start collecting respondent evaluations.
                  </span>
                  <div style={{ display: "flex", justifyContent: "center", gap: "0.75rem", marginTop: "0.5rem" }}>
                    <Link href="/admin/tests/new" className="admin-button admin-button--primary">
                      Create a Test
                    </Link>
                    <Link href="/admin/audio" className="admin-button">
                      Explore Audio Library
                    </Link>
                  </div>
                </div>
              ) : (
                <div className="dashboard-study-list">
                  {publishedTests.map((test) => (
                    <article key={test.id} className="dashboard-study-item">
                      <div className="dashboard-study-item__top">
                        <div>
                          <h3 className="dashboard-study-item__title">{test.name}</h3>
                          <div className="dashboard-study-item__meta">
                            <span>v{test.version}</span>
                            <span>•</span>
                            <span>{test.stimuli_count} Stimuli</span>
                            <span>•</span>
                            <span>Test #{test.id}</span>
                          </div>
                        </div>
                        <span className="status-badge status-badge--published">Active</span>
                      </div>

                      {/* Access Code & Link Bar */}
                      <div className="dashboard-study-item__code-bar">
                        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                          <span className="muted" style={{ fontSize: "0.75rem", fontWeight: "600" }}>
                            Access Code:
                          </span>
                          {test.access_code ? (
                            <code className="dashboard-access-code">{test.access_code}</code>
                          ) : (
                            <span className="muted" style={{ fontSize: "0.8rem", fontStyle: "italic" }}>
                              Open / Direct URL
                            </span>
                          )}
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                          {test.access_code && (
                            <button
                              type="button"
                              onClick={() => void handleCopyCode(test.id, test.access_code || "")}
                              className={`dashboard-mini-btn ${
                                copiedCodeId === test.id ? "dashboard-mini-btn--copied" : ""
                              }`}
                              title="Copy Access Code"
                            >
                              {copiedCodeId === test.id ? <CheckIcon /> : <CopyIcon />}
                              {copiedCodeId === test.id ? "Copied" : "Copy Code"}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void handleCopyLink(test.id, test.access_code)}
                            className={`dashboard-mini-btn ${
                              copiedLinkId === test.id ? "dashboard-mini-btn--copied" : ""
                            }`}
                            title="Copy Respondent Evaluation URL"
                          >
                            {copiedLinkId === test.id ? <CheckIcon /> : <ExternalLinkIcon />}
                            {copiedLinkId === test.id ? "Link Copied" : "Copy Link"}
                          </button>
                        </div>
                      </div>

                      {/* Study Quick Stats */}
                      <div className="dashboard-study-item__stats">
                        <div className="dashboard-stat-unit">
                          <span className="dashboard-stat-unit__label">Sessions</span>
                          <span className="dashboard-stat-unit__val">
                            {test.sessions_completed} / {test.sessions_started}
                          </span>
                        </div>
                        <div className="dashboard-stat-unit">
                          <span className="dashboard-stat-unit__label">MOS Mean</span>
                          <span className="dashboard-stat-unit__val">
                            {test.mos_mean !== null ? `${test.mos_mean.toFixed(2)} ★` : "—"}
                          </span>
                        </div>
                        <div className="dashboard-stat-unit">
                          <span className="dashboard-stat-unit__label">SUS WAcc</span>
                          <span className="dashboard-stat-unit__val">
                            {test.sus_wacc_mean !== null ? `${(test.sus_wacc_mean * 100).toFixed(1)}%` : "—"}
                          </span>
                        </div>
                      </div>

                      {/* Action Links */}
                      <div className="dashboard-study-item__actions">
                        <Link
                          href={`/admin/results`}
                          className="admin-button admin-button--sm"
                        >
                          View Results
                        </Link>
                        <Link
                          href={`/admin/tests/new?id=${test.id}`}
                          className="admin-button admin-button--sm admin-button--primary"
                        >
                          Edit Study
                        </Link>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* Engine Benchmark Leaderboard */}
          <section className="dashboard-card" aria-labelledby="benchmark-title">
            <div className="dashboard-card__header">
              <div className="dashboard-card__title-group">
                <HeadphonesIcon />
                <h2 id="benchmark-title">Speech Engine Benchmarks</h2>
              </div>
              <Link href="/admin/master-data/engines" className="dashboard-card__action-link">
                Manage engines ({readiness.engines.count}) →
              </Link>
            </div>
            <div className="dashboard-card__body">
              {engine_benchmarks.length === 0 ? (
                <p className="muted" style={{ margin: 0, fontSize: "var(--text-sm)" }}>
                  No speech engines registered yet. Add voice synthesis or processing models in Configuration.
                </p>
              ) : (
                <div className="dashboard-table-wrapper">
                  <table className="dashboard-table">
                    <thead>
                      <tr>
                        <th>Engine Name</th>
                        <th>MOS Naturalness</th>
                        <th>SUS Word Accuracy</th>
                        <th>Samples (n)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {engine_benchmarks.map((eng) => (
                        <tr key={eng.id}>
                          <td>
                            <div className="dashboard-engine-name">{eng.name}</div>
                            {eng.description && <span className="muted">{eng.description}</span>}
                          </td>
                          <td>
                            <div className="dashboard-score-cell">
                              <span className="dashboard-score-val">
                                {eng.mos_mean !== null
                                  ? `${eng.mos_mean.toFixed(2)}${
                                      eng.mos_stddev ? ` ± ${eng.mos_stddev.toFixed(2)}` : ""
                                    }`
                                  : "—"}
                              </span>
                              <div className="dashboard-score-track">
                                <div
                                  className="dashboard-score-fill"
                                  style={{
                                    width: `${eng.mos_mean !== null ? (eng.mos_mean / 5) * 100 : 0}%`,
                                  }}
                                />
                              </div>
                            </div>
                          </td>
                          <td>
                            <div className="dashboard-score-cell">
                              <span className="dashboard-score-val">
                                {eng.sus_wacc_mean !== null ? `${(eng.sus_wacc_mean * 100).toFixed(1)}%` : "—"}
                              </span>
                              <div className="dashboard-score-track">
                                <div
                                  className="dashboard-score-fill dashboard-score-fill--sus"
                                  style={{
                                    width: `${eng.sus_wacc_mean !== null ? eng.sus_wacc_mean * 100 : 0}%`,
                                  }}
                                />
                              </div>
                            </div>
                          </td>
                          <td>
                            <span className="dashboard-score-val">
                              {Math.max(eng.mos_n, eng.sus_n) > 0 ? Math.max(eng.mos_n, eng.sus_n) : "0"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          {/* Offline System & Storage Box (Under Engine Benchmarks on desktop) */}
          <div className="dashboard-system-box">
            <div className="dashboard-system-box__header">
              <ShieldIcon />
              Offline-First & Security Guarantee
            </div>
            <p className="dashboard-system-box__desc">
              Dengar operates with zero external runtime network requests. Audio files and responses are securely stored
              in your single-file SQLite database.
            </p>
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.25rem" }}>
              <Link
                href="/admin/backup"
                className="admin-button"
                style={{ fontSize: "var(--text-xs)", padding: "0.35rem 0.65rem" }}
              >
                Database Backup
              </Link>
              <Link
                href="/admin/settings"
                className="admin-button"
                style={{ fontSize: "var(--text-xs)", padding: "0.35rem 0.65rem" }}
              >
                Admin Settings
              </Link>
            </div>
          </div>
        </div>

        {/* Right Column: Readiness Checklist, Live Activity */}
        <div className="dashboard-col-right">
          {/* Setup & Master Data Readiness */}
          <section className="dashboard-card" aria-labelledby="readiness-title">
            <div className="dashboard-card__header">
              <div className="dashboard-card__title-group">
                <LayersIcon />
                <h2 id="readiness-title">Study Readiness Checklist</h2>
              </div>
            </div>
            <div className="dashboard-card__body">
              <div className="dashboard-checklist">
                <Link href="/admin/audio" className="dashboard-check-item">
                  <div className="dashboard-check-item__left">
                    <CheckCircleIcon
                      className={`dashboard-check-item__status-icon ${
                        readiness.audio_assets.ready
                          ? "dashboard-check-item__status-icon--ready"
                          : "dashboard-check-item__status-icon--pending"
                      }`}
                    />
                    <span className="dashboard-check-item__label">Audio Library Files</span>
                  </div>
                  <span className="dashboard-check-item__count">
                    {readiness.audio_assets.count} clips ({formatBytes(metrics.audio?.total_size_bytes)})
                  </span>
                </Link>

                <Link href="/admin/master-data/engines" className="dashboard-check-item">
                  <div className="dashboard-check-item__left">
                    <CheckCircleIcon
                      className={`dashboard-check-item__status-icon ${
                        readiness.engines.ready
                          ? "dashboard-check-item__status-icon--ready"
                          : "dashboard-check-item__status-icon--pending"
                      }`}
                    />
                    <span className="dashboard-check-item__label">Speech Engines Configured</span>
                  </div>
                  <span className="dashboard-check-item__count">{readiness.engines.count} engines</span>
                </Link>

                <Link href="/admin/master-data/mos-scales" className="dashboard-check-item">
                  <div className="dashboard-check-item__left">
                    <CheckCircleIcon
                      className={`dashboard-check-item__status-icon ${
                        readiness.mos_scales.ready
                          ? "dashboard-check-item__status-icon--ready"
                          : "dashboard-check-item__status-icon--pending"
                      }`}
                    />
                    <span className="dashboard-check-item__label">MOS Scale Presets</span>
                  </div>
                  <span className="dashboard-check-item__count">{readiness.mos_scales.count} presets</span>
                </Link>

                <Link href="/admin/master-data/demographic-fields" className="dashboard-check-item">
                  <div className="dashboard-check-item__left">
                    <CheckCircleIcon
                      className={`dashboard-check-item__status-icon ${
                        readiness.demographics.ready
                          ? "dashboard-check-item__status-icon--ready"
                          : "dashboard-check-item__status-icon--pending"
                      }`}
                    />
                    <span className="dashboard-check-item__label">Demographic Questions</span>
                  </div>
                  <span className="dashboard-check-item__count">{readiness.demographics.count} fields</span>
                </Link>

                <Link href="/admin/master-data/text-templates" className="dashboard-check-item">
                  <div className="dashboard-check-item__left">
                    <CheckCircleIcon
                      className={`dashboard-check-item__status-icon ${
                        readiness.text_templates.ready
                          ? "dashboard-check-item__status-icon--ready"
                          : "dashboard-check-item__status-icon--pending"
                      }`}
                    />
                    <span className="dashboard-check-item__label">Consent & Intro Templates</span>
                  </div>
                  <span className="dashboard-check-item__count">{readiness.text_templates.count} templates</span>
                </Link>
              </div>
            </div>
          </section>

          {/* Recent Activity Feed */}
          <section className="dashboard-card" aria-labelledby="activity-title">
            <div className="dashboard-card__header">
              <div className="dashboard-card__title-group">
                <ActivityIcon />
                <h2 id="activity-title">Recent Respondent Sessions</h2>
              </div>
            </div>
            <div className="dashboard-card__body">
              {recent_activity.length === 0 ? (
                <p className="muted" style={{ margin: 0, fontSize: "var(--text-sm)" }}>
                  No respondent sessions recorded yet. Completed respondent responses will stream here.
                </p>
              ) : (
                <div className="dashboard-activity-list">
                  {recent_activity.map((item) => (
                    <div key={item.id} className="dashboard-activity-item">
                      <div
                        className={`dashboard-activity-item__dot ${
                          item.status === "completed"
                            ? "dashboard-activity-item__dot--completed"
                            : "dashboard-activity-item__dot--active"
                        }`}
                      />
                      <div className="dashboard-activity-item__content">
                        <div className="dashboard-activity-item__title-row">
                          <span className="dashboard-activity-item__name">{item.test_name}</span>
                          <span className="dashboard-activity-item__time">
                            {formatTimestamp(item.completed_at || item.created_at)}
                          </span>
                        </div>
                        <div className="dashboard-activity-item__sub">
                          Session #{item.id} ·{" "}
                          <span
                            style={{
                              fontWeight: "600",
                              color: item.status === "completed" ? "var(--color-success)" : "var(--color-warning)",
                            }}
                          >
                            {item.status}
                          </span>{" "}
                          · {formatDuration(item.duration_seconds)} ({item.mos_responses_count} MOS,{" "}
                          {item.sus_responses_count} SUS)
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}