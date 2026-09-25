import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import AdminDashboard from "../app/admin/page";

const mockDashboardData = {
  metrics: {
    total_tests: 3,
    published_tests: 2,
    draft_tests: 1,
    total_sessions: 25,
    completed_sessions: 20,
    active_sessions: 5,
    completion_rate: 80.0,
    mos: {
      total_ratings: 120,
      mean: 4.25,
      ci95: { lower: 4.10, upper: 4.40 },
    },
    sus: {
      total_evaluations: 60,
      mean_wacc: 0.935,
      total_substitutions: 8,
      total_deletions: 4,
      total_insertions: 2,
    },
    audio: {
      total_assets: 48,
      total_size_bytes: 52428800,
      engines_covered: 3,
    },
    system: {
      offline_mode: true,
      database_engine: "SQLite",
      storage_healthy: true,
    },
  },
  active_tests: [
    {
      id: 1,
      name: "Voice Naturalness Benchmark",
      version: 1,
      status: "published",
      access_code: "VOICE1",
      stimuli_count: 12,
      created_at: "2026-09-01T10:00:00",
      sessions_started: 15,
      sessions_completed: 12,
      mos_mean: 4.35,
      sus_wacc_mean: 0.94,
    },
    {
      id: 2,
      name: "Intelligibility in Noise",
      version: 2,
      status: "published",
      access_code: null,
      stimuli_count: 8,
      created_at: "2026-08-30T14:30:00",
      sessions_started: 10,
      sessions_completed: 8,
      mos_mean: 4.10,
      sus_wacc_mean: 0.92,
    },
    {
      id: 3,
      name: "Draft Study Setup",
      version: 1,
      status: "draft",
      access_code: null,
      stimuli_count: 4,
      created_at: "2026-09-02T08:00:00",
      sessions_started: 0,
      sessions_completed: 0,
      mos_mean: null,
      sus_wacc_mean: null,
    },
  ],
  engine_benchmarks: [
    {
      id: 1,
      name: "VITS Model",
      description: "End-to-end neural TTS",
      mos_n: 60,
      mos_mean: 4.45,
      mos_stddev: 0.35,
      sus_n: 30,
      sus_wacc_mean: 0.955,
      stimuli_count: 10,
    },
    {
      id: 2,
      name: "Tacotron 2",
      description: "Two-stage acoustic model",
      mos_n: 60,
      mos_mean: 4.05,
      mos_stddev: 0.42,
      sus_n: 30,
      sus_wacc_mean: 0.915,
      stimuli_count: 10,
    },
  ],
  recent_activity: [
    {
      id: 101,
      test_id: 1,
      test_name: "Voice Naturalness Benchmark",
      status: "completed",
      created_at: "2026-09-02T09:00:00",
      completed_at: "2026-09-02T09:08:30",
      duration_seconds: 510,
      mos_responses_count: 12,
      sus_responses_count: 6,
    },
  ],
  readiness: {
    engines: { count: 3, ready: true },
    mos_scales: { count: 2, ready: true },
    demographics: { count: 4, ready: true },
    text_templates: { count: 3, ready: true },
    audio_assets: { count: 48, ready: true },
    tests: { count: 3, ready: true },
    has_published_test: true,
  },
};

describe("AdminDashboard", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders key performance indicator metrics and active studies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockDashboardData,
      })
    );

    render(<AdminDashboard />);

    await waitFor(() => {
      expect(screen.getAllByText("Voice Naturalness Benchmark").length).toBeGreaterThan(0);
    });

    // Check KPI cards
    expect(screen.getByText("Active Studies")).toBeInTheDocument();
    expect(screen.getByText("Participation")).toBeInTheDocument();
    expect(screen.getAllByText("MOS Naturalness").length).toBeGreaterThan(0);
    expect(screen.getByText("SUS Intelligibility")).toBeInTheDocument();

    // Check scores
    expect(screen.getByText("4.25")).toBeInTheDocument();
    expect(screen.getByText("93.5%")).toBeInTheDocument();
    expect(screen.getByText("80% completion rate")).toBeInTheDocument();

    // Check published study cards
    expect(screen.getByText("VOICE1")).toBeInTheDocument();
    expect(screen.getByText("Intelligibility in Noise")).toBeInTheDocument();

    // Check engine leaderboard
    expect(screen.getByText("VITS Model")).toBeInTheDocument();
    expect(screen.getByText("Tacotron 2")).toBeInTheDocument();

    // Check recent activity
    expect(screen.getByText(/Session #101/)).toBeInTheDocument();

    // Check readiness items
    expect(screen.getByText("Audio Library Files")).toBeInTheDocument();
    expect(screen.getByText("Speech Engines Configured")).toBeInTheDocument();
  });

  it("handles clipboard copying for access code and respondent link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockDashboardData,
      })
    );

    render(<AdminDashboard />);

    await waitFor(() => {
      expect(screen.getAllByText("Voice Naturalness Benchmark").length).toBeGreaterThan(0);
    });

    const copyCodeBtn = screen.getByRole("button", { name: /Copy Code/i });
    fireEvent.click(copyCodeBtn);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("VOICE1");
      expect(screen.getByText("Copied")).toBeInTheDocument();
    });

    const copyLinkBtns = screen.getAllByRole("button", { name: /Copy Link/i });
    fireEvent.click(copyLinkBtns[0]);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining("/get-started?code=VOICE1")
      );
      expect(screen.getByText("Link Copied")).toBeInTheDocument();
    });
  });

  it("renders empty state when no studies are published", async () => {
    const emptyData = {
      ...mockDashboardData,
      metrics: {
        ...mockDashboardData.metrics,
        total_tests: 0,
        published_tests: 0,
        draft_tests: 0,
        total_sessions: 0,
        completed_sessions: 0,
        completion_rate: 0,
        mos: { total_ratings: 0, mean: null, ci95: null },
        sus: { total_evaluations: 0, mean_wacc: null, total_substitutions: 0, total_deletions: 0, total_insertions: 0 },
      },
      active_tests: [],
      engine_benchmarks: [],
      recent_activity: [],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => emptyData,
      })
    );

    render(<AdminDashboard />);

    await waitFor(() => {
      expect(screen.getByText("No studies published yet")).toBeInTheDocument();
    });

    expect(screen.getByText("No respondent sessions recorded yet. Completed respondent responses will stream here.")).toBeInTheDocument();
  });

  it("handles error response and allows retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: "Server error" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockDashboardData,
      });

    vi.stubGlobal("fetch", fetchMock);

    render(<AdminDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Could not load dashboard data")).toBeInTheDocument();
    });

    const retryBtn = screen.getByRole("button", { name: /Retry/i });
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.getAllByText("Voice Naturalness Benchmark").length).toBeGreaterThan(0);
    });
  });
});
