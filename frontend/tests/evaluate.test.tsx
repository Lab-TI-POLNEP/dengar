import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import EvaluatePage from "../app/evaluate/page";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}));

const mockMosConfig = {
  min: 1,
  max: 5,
  labels: ["Buruk", "Kurang", "Cukup", "Baik", "Sangat Baik"],
};

function mockFetchEvaluateApi() {
  let step = 0;
  
  return vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};

    if (url.endsWith("/api/sessions/next-stimulus")) {
      if (body.token !== "mock-session-token-12345") {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: "Invalid session token" }),
        };
      }

      if (step === 0) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "active",
            test_name: "Mock Evaluation Test",
            current_index: 1,
            total_stimuli: 2,
            stimulus: {
              id: 101,
              neutral_label: "S1",
              kind: "mos",
            },
            mos_config: mockMosConfig,
          }),
        };
      } else if (step === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "active",
            test_name: "Mock Evaluation Test",
            current_index: 2,
            total_stimuli: 2,
            stimulus: {
              id: 102,
              neutral_label: "S2",
              kind: "sus",
            },
            mos_config: mockMosConfig,
          }),
        };
      } else {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "completed",
            message: "Thank you for participating.",
          }),
        };
      }
    }

    if (url.endsWith("/api/sessions/response")) {
      expect(body.token).toBe("mock-session-token-12345");
      expect([101, 102]).toContain(body.stimulus_id);
      if (body.stimulus_id === 101) {
        expect(body.rating).toBe(4);
      }
      step++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "success" }),
      };
    }

    if (url.endsWith("/api/sessions/sus/play-authorize")) {
      return {
        ok: true,
        status: 201,
        json: async () => ({ authorization_id: "sus-auth-1", quota: 2, plays_used: 0 }),
      };
    }

    if (url.includes("/api/media/stream/")) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(8),
      };
    }

    return { ok: false, status: 404, json: async () => ({}) };
  });
}

describe("EvaluatePage", () => {
  beforeEach(() => {
    pushMock.mockClear();
    sessionStorage.clear();
    
    // Mock HTMLMediaElement.prototype.play and pause since they aren't implemented in jsdom
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:mock-sus-audio"),
      revokeObjectURL: vi.fn(),
    });
    class MockAudioContext {
      currentTime = 0;
      state = "running";
      destination = {} as AudioDestinationNode;
      constructor() { vi.stubGlobal("susAudioContext", this); }
      async resume() {}
      async decodeAudioData() { return { duration: 1 } as AudioBuffer; }
      createBufferSource() {
        const source = {
          buffer: null,
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          onended: null as (() => void) | null,
        };
        vi.stubGlobal("susSource", source);
        return source as unknown as AudioBufferSourceNode;
      }
    }
    vi.stubGlobal("AudioContext", MockAudioContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("redirects to /get-started if session token is missing in sessionStorage", () => {
    render(<EvaluatePage />);
    expect(pushMock).toHaveBeenCalledWith("/get-started");
  });

  it("renders player, Likert scale, gates next button, progress indicator, and handles the evaluation flow through completion", async () => {
    sessionStorage.setItem("session_token", "mock-session-token-12345");
    const fetchSpy = mockFetchEvaluateApi();
    vi.stubGlobal("fetch", fetchSpy);

    render(<EvaluatePage />);

    // 1. Initial MOS Evaluation step
    await waitFor(() => expect(screen.getByText("Mock Evaluation Test")).toBeInTheDocument());
    expect(screen.getByText("Stimulus 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("Listen and rate naturalness")).toBeInTheDocument();
    
    // Verify audio player elements exist
    const playBtn = screen.getByLabelText("Play audio");
    expect(playBtn).toBeInTheDocument();
    
    // Verify Likert scale buttons render dynamically from configuration
    expect(screen.getByLabelText("Rate 1: Buruk")).toBeInTheDocument();
    expect(screen.getByLabelText("Rate 2: Kurang")).toBeInTheDocument();
    expect(screen.getByLabelText("Rate 3: Cukup")).toBeInTheDocument();
    expect(screen.getByLabelText("Rate 4: Baik")).toBeInTheDocument();
    expect(screen.getByLabelText("Rate 5: Sangat Baik")).toBeInTheDocument();

    // Check privacy: No leaks of original engine names or paths
    const bodyText = document.body.innerHTML;
    expect(bodyText).not.toContain("Engine");
    expect(bodyText).not.toContain("asset-");
    expect(bodyText).not.toContain(".wav");

    // The Next button should be disabled until a rating is chosen
    const nextBtn = screen.getByRole("button", { name: "Submit rating and continue" });
    expect(nextBtn).toBeDisabled();

    // Play the audio to register play count
    fireEvent.click(playBtn);
    expect(playBtn.getAttribute("aria-label")).toBe("Pause audio");

    // Choose rating of 4
    const rate4Btn = screen.getByLabelText("Rate 4: Baik");
    fireEvent.click(rate4Btn);
    expect(nextBtn).toBeEnabled();

    // Submit MOS Rating
    fireEvent.click(nextBtn);

    // 2. SUS evaluation step
    await waitFor(() => expect(screen.getByText("SUS Intelligibility Task")).toBeInTheDocument());
    expect(screen.getByText("Stimulus 2 of 2")).toBeInTheDocument();

    const playSusBtn = screen.getByRole("button", { name: "Play SUS audio" });
    fireEvent.click(playSusBtn);
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause SUS audio" })).toBeInTheDocument());
    expect(screen.getByText("Listen at least once before continuing. Plays used: 0 of 2.")).toBeInTheDocument();
    fireEvent.ended(document.querySelector("audio") as HTMLAudioElement);
    fireEvent.change(screen.getByLabelText("Transcription"), { target: { value: "satu dua" } });
    const nextSusBtn = screen.getByRole("button", { name: "Submit transcription and continue" });
    expect(nextSusBtn).toBeEnabled();

    fireEvent.click(nextSusBtn);

    // 3. Finalization screen
    await waitFor(() => expect(screen.getByText("Thank you.")).toBeInTheDocument());
    expect(screen.getByText("Your speech evaluation session is finished. Your answers have been safely saved.")).toBeInTheDocument();

    const exitBtn = screen.getByRole("button", { name: "Exit Session" });
    fireEvent.click(exitBtn);

    expect(pushMock).toHaveBeenCalledWith("/get-started");
    expect(sessionStorage.getItem("session_token")).toBeNull();
  });
});
