import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ResultsPage from "../app/admin/results/page";

const mockTests = [
  { id: 1, name: "Test Study 1", version: 1, status: "published" },
  { id: 2, name: "Test Study 2", version: 1, status: "draft" }
];

const mockResultsData = {
  summary: {
    sessions_started: 10,
    sessions_completed: 8,
    mos: {
      n: 5,
      mean: 4.25,
      ci95: { lower: 3.63, upper: 4.87 }
    },
    sus: {
      n: 3,
      wacc_mean: 0.85
    }
  },
  engines: [
    {
      engine_id: 10,
      engine_name: "Engine A",
      mos_n: 5,
      mos_mean: 4.25,
      mos_stddev: 0.5,
      sus_n: 3,
      sus_wacc_mean: 0.85
    }
  ],
  stimuli: [
    {
      id: 101,
      neutral_label: "S1",
      kind: "mos",
      engine_id: 10,
      engine_name: "Engine A",
      audio_ref: "clip-1",
      stats: {
        n: 5,
        mean: 4.25,
        stddev: 0.5
      }
    },
    {
      id: 102,
      neutral_label: "S2",
      kind: "sus",
      engine_id: 10,
      engine_name: "Engine A",
      audio_ref: "clip-2",
      stats: {
        n: 3,
        wacc_mean: 0.85
      }
    }
  ],
  respondents: [
    {
      id: 1,
      token_anonymized: "abc12345...",
      status: "completed",
      created_at: "2026-08-30T10:00:00",
      completed_at: "2026-08-30T10:05:00",
      duration_seconds: 300,
      demographics: { age: "18–25 years", normal_hearing: "Yes" },
      responses: [
        {
          stimulus_id: 101,
          neutral_label: "S1",
          kind: "mos",
          rating: 4,
          play_count: 1
        },
        {
          stimulus_id: 102,
          neutral_label: "S2",
          kind: "sus",
          raw_transcription: "this is a test",
          normalized_transcription: "this is a test",
          wacc: 1.0,
          substitutions: 1,
          deletions: 2,
          insertions: 3,
          play_count: 2
        }
      ]
    }
  ]
};

const mockEmptyResultsData = {
  summary: {
    sessions_started: 0,
    sessions_completed: 0,
    mos: { n: 0, mean: null, ci95: null },
    sus: { n: 0, wacc_mean: null }
  },
  engines: [],
  stimuli: [],
  respondents: []
};

function mockFetchResultsApi() {
  return vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/admin/api/tests")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: mockTests })
      };
    }
    if (url.endsWith("/admin/api/tests/1/results")) {
      return {
        ok: true,
        status: 200,
        json: async () => mockResultsData
      };
    }
    if (url.endsWith("/admin/api/tests/2/results")) {
      return {
        ok: true,
        status: 200,
        json: async () => mockEmptyResultsData
      };
    }
    if (url.endsWith("/results/export")) {
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob(["csv-content"], { type: "text/csv" })
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

describe("ResultsPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders dropdown, handles test selection, renders summary statistics, drill-down tables, and handles csv export", async () => {
    const fetchSpy = mockFetchResultsApi();
    vi.stubGlobal("fetch", fetchSpy);

    // Mock URL.createObjectURL and URL.revokeObjectURL
    const createObjectURLMock = vi.fn().mockReturnValue("blob-url");
    const revokeObjectURLMock = vi.fn();
    vi.stubGlobal("URL", {
      createObjectURL: createObjectURLMock,
      revokeObjectURL: revokeObjectURLMock
    });

    render(<ResultsPage />);

    // Renders dropdown with test options
    const select = await screen.findByLabelText("Select Test Study");
    expect(select).toBeInTheDocument();

    // Wait for dropdown options to populate
    await screen.findByText("Test Study 1 (published)");
    
    // Choose Test study 1
    fireEvent.change(select, { target: { value: "1" } });

    // Verify summary statistics render
    await waitFor(() => expect(screen.getByText("Sessions Started")).toBeInTheDocument());
    expect(screen.getByText("10")).toBeInTheDocument(); // started
    expect(screen.getByText("8")).toBeInTheDocument(); // completed

    // Verify Engine Table renders correct metrics
    expect(screen.getByText("MOS Mean (n=5)")).toBeInTheDocument();
    expect(screen.getByText("4.25")).toBeInTheDocument();
    expect(screen.getByText("95% CI 3.63 to 4.87")).toBeInTheDocument();
    expect(screen.getByText("SUS WAcc (n=3)")).toBeInTheDocument();
    expect(screen.getAllByText("85.0%").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("SUS Error Breakdown")).toBeInTheDocument();
    expect(screen.getByText("Substitutions")).toBeInTheDocument();
    expect(screen.getByText("Deletions")).toBeInTheDocument();
    expect(screen.getByText("Insertions")).toBeInTheDocument();
    expect(screen.getAllByText("1").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("2").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("3").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Engine Performance Summary")).toBeInTheDocument();
    expect(screen.getAllByText("Engine A")[0]).toBeInTheDocument();
    expect(screen.getAllByText("4.25 ± 0.50")[0]).toBeInTheDocument(); // MOS mean ± stddev
    expect(screen.getAllByText("85.0%").length).toBeGreaterThanOrEqual(2); // summary and engine WAcc %

    // Verify Stimulus details table
    expect(screen.getByText("Stimulus Performance Detail")).toBeInTheDocument();
    expect(screen.getByText("clip-1")).toBeInTheDocument();
    expect(screen.getByText("clip-2")).toBeInTheDocument();
    expect(screen.getByText("85.0% WAcc")).toBeInTheDocument();

    // Verify Respondent Session Detail table
    expect(screen.getByText("Respondent Sessions Detail")).toBeInTheDocument();
    expect(screen.getByText("Session #1")).toBeInTheDocument();
    expect(screen.getByText("2026-08-30 10:05")).toBeInTheDocument(); // completed timestamp
    expect(screen.getByText("5m 0s")).toBeInTheDocument(); // duration
    expect(screen.getByText("age: 18–25 years")).toBeInTheDocument();
    expect(screen.getByText("normal_hearing: Yes")).toBeInTheDocument();

    // Export CSV button click
    const exportBtn = screen.getByRole("button", { name: "Export CSV" });
    expect(exportBtn).toBeInTheDocument();
    fireEvent.click(exportBtn);

    await waitFor(() => expect(createObjectURLMock).toHaveBeenCalled());
  });

  it("renders empty state correctly if no responses exist for the selected test", async () => {
    const fetchSpy = mockFetchResultsApi();
    vi.stubGlobal("fetch", fetchSpy);

    render(<ResultsPage />);

    const select = await screen.findByLabelText("Select Test Study");
    
    // Wait for dropdown options to populate
    await screen.findByText("Test Study 2 (draft)");

    fireEvent.change(select, { target: { value: "2" } });

    // Renders empty state
    await waitFor(() => expect(screen.getByText("No results yet")).toBeInTheDocument());
    expect(
      screen.getByText("Completed respondent sessions will appear here once respondents participate.")
    ).toBeInTheDocument();
  });

  it("communicates when a MOS confidence interval is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/admin/api/tests")) {
        return { ok: true, status: 200, json: async () => ({ items: mockTests }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          summary: {
            sessions_started: 1,
            sessions_completed: 1,
            mos: { n: 1, mean: 4, ci95: null },
            sus: { n: 0, wacc_mean: null }
          },
          engines: [],
          stimuli: [],
          respondents: []
        })
      };
    }));

    render(<ResultsPage />);
    const select = await screen.findByLabelText("Select Test Study");
    await screen.findByText("Test Study 1 (published)");
    fireEvent.change(select, { target: { value: "1" } });

    expect(await screen.findByText("MOS Mean (n=1)")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("at least two ratings");
    expect(screen.getByText("95% CI unavailable: at least 2 ratings required")).toBeInTheDocument();
  });

  it("allows deleting a respondent session and handles pagination", async () => {
    const paginatedRespondents = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      token_anonymized: `token${i + 1}...`,
      status: "completed",
      created_at: "2026-08-30T10:00:00",
      completed_at: "2026-08-30T10:05:00",
      duration_seconds: 300,
      demographics: { age: "18–25 years", normal_hearing: "Yes" },
      responses: []
    }));

    const paginatedResultsData = {
      summary: {
        sessions_started: 12,
        sessions_completed: 12,
        mos: { n: 0, mean: null, ci95: null },
        sus: { n: 0, wacc_mean: null }
      },
      engines: [],
      stimuli: [],
      respondents: paginatedRespondents
    };

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    let deletedSessionId: string | null = null;
    let resultsFetchCount = 0;

    const fetchSpy = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/admin/api/tests")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: mockTests })
        };
      }
      if (url.endsWith("/admin/csrf-token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ csrf_token: "test-csrf-token" })
        };
      }
      if (url.endsWith("/admin/api/tests/1/results")) {
        resultsFetchCount++;
        if (resultsFetchCount > 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ...paginatedResultsData,
              summary: {
                sessions_started: 11,
                sessions_completed: 11,
                mos: { n: 0, mean: null, ci95: null },
                sus: { n: 0, wacc_mean: null }
              },
              respondents: paginatedRespondents.filter(r => r.id !== 1)
            })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => paginatedResultsData
        };
      }
      if (url.includes("/sessions/")) {
        const parts = url.split("/");
        deletedSessionId = parts[parts.length - 1];
        return {
          ok: true,
          status: 204
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(<ResultsPage />);

    const select = await screen.findByLabelText("Select Test Study");
    await screen.findByText("Test Study 1 (published)");
    fireEvent.change(select, { target: { value: "1" } });

    await waitFor(() => expect(screen.getByText("Session #1")).toBeInTheDocument());
    expect(screen.getByText("Session #5")).toBeInTheDocument();
    expect(screen.queryByText("Session #6")).not.toBeInTheDocument();
    expect(screen.getByText(/Showing/)).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Respondent sessions pages" })).toHaveTextContent("12");

    const nextBtn = screen.getByRole("button", { name: "Next page" });
    fireEvent.click(nextBtn);

    await waitFor(() => expect(screen.getByText("Session #6")).toBeInTheDocument());
    expect(screen.getByText("Session #10")).toBeInTheDocument();
    expect(screen.queryByText("Session #1")).not.toBeInTheDocument();

    const prevBtn = screen.getByRole("button", { name: "Previous page" });
    fireEvent.click(prevBtn);

    await waitFor(() => expect(screen.getByText("Session #1")).toBeInTheDocument());
    expect(screen.queryByText("Session #11")).not.toBeInTheDocument();

    const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
    fireEvent.click(deleteButtons[0]);

    expect(confirmSpy).toHaveBeenCalledWith("Delete respondent session #1? This cannot be undone.");
    await waitFor(() => expect(deletedSessionId).toBe("1"));

    await waitFor(() => expect(screen.getByRole("navigation", { name: "Respondent sessions pages" })).toHaveTextContent("11"));
  });
});

