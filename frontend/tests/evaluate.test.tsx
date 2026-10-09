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

  it("reuses buffered audio on pause/resume without re-authorizing and allows empty transcription", async () => {
    sessionStorage.setItem("session_token", "mock-session-token-12345");
    let authorizeCalls = 0;
    let streamCalls = 0;

    const fetchSpy = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/sessions/next-stimulus")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "active",
            test_name: "SUS Only Test",
            current_index: 1,
            total_stimuli: 1,
            stimulus: { id: 201, neutral_label: "SUS1", kind: "sus" },
            mos_config: mockMosConfig,
          }),
        };
      }
      if (url.endsWith("/api/sessions/sus/play-authorize")) {
        authorizeCalls++;
        return {
          ok: true,
          status: 201,
          json: async () => ({ authorization_id: "sus-auth-test-xyz", quota: 2, plays_used: 0 }),
        };
      }
      if (url.includes("/api/media/stream/")) {
        streamCalls++;
        // Verify X-Play-Authorization header is present
        expect((init?.headers as Record<string, string>)?.["X-Play-Authorization"]).toBe("sus-auth-test-xyz");
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(8),
        };
      }
      if (url.endsWith("/api/sessions/response")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        expect(body.authorization_id).toBe("sus-auth-test-xyz");
        expect(body.transcription).toBe("");
        return { ok: true, status: 200, json: async () => ({ status: "success" }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(<EvaluatePage />);
    await waitFor(() => expect(screen.getByText("SUS Intelligibility Task")).toBeInTheDocument());

    const textarea = screen.getByLabelText("Transcription");
    const continueBtn = screen.getByRole("button", { name: "Submit transcription and continue" });
    // Textarea and continue button should initially be disabled before playback
    expect(textarea).toBeDisabled();
    expect(continueBtn).toBeDisabled();

    // 1. First Play
    const playBtn = screen.getByRole("button", { name: "Play SUS audio" });
    fireEvent.click(playBtn);

    await waitFor(() => expect(screen.getByRole("button", { name: "Pause SUS audio" })).toBeInTheDocument());
    expect(authorizeCalls).toBe(1);
    expect(streamCalls).toBe(1);

    // 2. Pause
    const pauseBtn = screen.getByRole("button", { name: "Pause SUS audio" });
    fireEvent.click(pauseBtn);
    await waitFor(() => expect(screen.getByRole("button", { name: "Play SUS audio" })).toBeInTheDocument());

    // 3. Resume -> MUST NOT call authorize or stream again!
    const resumeBtn = screen.getByRole("button", { name: "Play SUS audio" });
    fireEvent.click(resumeBtn);
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause SUS audio" })).toBeInTheDocument());
    expect(authorizeCalls).toBe(1);
    expect(streamCalls).toBe(1);

    // 4. End of playback enables textarea and continue button even with empty transcription
    const audioEl = document.querySelector("audio") as HTMLAudioElement;
    fireEvent.ended(audioEl);

    expect(textarea).toBeEnabled();
    expect(continueBtn).toBeEnabled();

    // Submit empty transcription
    fireEvent.click(continueBtn);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions/response"),
      expect.any(Object),
    ));
  });

  it("sends Idempotency-Key header, preserves snapshot on network failure, and replays exact key/payload without re-authorizing", async () => {
    sessionStorage.setItem("session_token", "mock-session-token-12345");
    let authorizeCalls = 0;
    let streamCalls = 0;
    let responseAttempts = 0;
    const capturedRequests: Array<{ key?: string; body: any }> = [];

    const fetchSpy = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/sessions/next-stimulus")) {
        if (responseAttempts === 0) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              status: "active",
              test_name: "SUS Idempotency Test",
              current_index: 1,
              total_stimuli: 1,
              stimulus: { id: 301, neutral_label: "SUS-IDEMP", kind: "sus" },
              mos_config: mockMosConfig,
            }),
          };
        } else {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              status: "completed",
              completion_text: "Session finished successfully.",
            }),
          };
        }
      }
      if (url.endsWith("/api/sessions/sus/play-authorize")) {
        authorizeCalls++;
        return {
          ok: true,
          status: 201,
          json: async () => ({ authorization_id: "auth-receipt-123", quota: 2, plays_used: 0 }),
        };
      }
      if (url.includes("/api/media/stream/")) {
        streamCalls++;
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(8),
        };
      }
      if (url.endsWith("/api/sessions/response")) {
        responseAttempts++;
        const headers = init?.headers as Record<string, string>;
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        capturedRequests.push({ key: headers?.["Idempotency-Key"], body });

        if (responseAttempts === 1) {
          // Simulate transport network failure (lost response / connection abort)
          throw new TypeError("Failed to fetch");
        }
        // Second attempt: succeeds
        return { ok: true, status: 200, json: async () => ({ status: "success", message: "Response saved" }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(<EvaluatePage />);
    await waitFor(() => expect(screen.getByText("SUS Intelligibility Task")).toBeInTheDocument());

    // Play and finish playback
    fireEvent.click(screen.getByRole("button", { name: "Play SUS audio" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause SUS audio" })).toBeInTheDocument());
    fireEvent.ended(document.querySelector("audio") as HTMLAudioElement);

    const textarea = screen.getByLabelText("Transcription");
    fireEvent.change(textarea, { target: { value: "kucing melompat" } });

    const submitBtn = screen.getByRole("button", { name: "Submit transcription and continue" });
    // Attempt 1: Transport failure
    fireEvent.click(submitBtn);

    // Verify error message and Retry submission button appears
    await waitFor(() => expect(screen.getByText("Network error saving response. Please retry submission.")).toBeInTheDocument());
    expect(capturedRequests).toHaveLength(1);
    const firstReq = capturedRequests[0];
    expect(firstReq.key).toBeDefined();
    expect(firstReq.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(firstReq.body.transcription).toBe("kucing melompat");
    expect(firstReq.body.authorization_id).toBe("auth-receipt-123");

    // Textarea must be disabled during ambiguous failure to prevent silent mutation
    expect(textarea).toBeDisabled();

    // Verify Retry button exists with aria-label="Retry submission"
    const retryBtn = screen.getAllByRole("button", { name: "Retry submission" })[0];
    expect(retryBtn).toBeInTheDocument();

    // Attempt 2: Click Retry submission
    fireEvent.click(retryBtn);

    await waitFor(() => expect(capturedRequests).toHaveLength(2));
    const secondReq = capturedRequests[1];
    // Exact same Idempotency-Key and payload
    expect(secondReq.key).toBe(firstReq.key);
    expect(secondReq.body).toEqual(firstReq.body);

    // No extra authorization or stream requests!
    expect(authorizeCalls).toBe(1);
    expect(streamCalls).toBe(1);

    // Reaches completion screen
    await waitFor(() => expect(screen.getByText("Thank you.")).toBeInTheDocument());
  });

  it("guards against concurrent in-flight submissions on rapid double click", async () => {
    sessionStorage.setItem("session_token", "mock-session-token-12345");
    let responseCalls = 0;

    const fetchSpy = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/sessions/next-stimulus")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "active",
            test_name: "SUS Guard Test",
            current_index: 1,
            total_stimuli: 1,
            stimulus: { id: 401, neutral_label: "SUS-GUARD", kind: "sus" },
            mos_config: mockMosConfig,
          }),
        };
      }
      if (url.endsWith("/api/sessions/sus/play-authorize")) {
        return {
          ok: true,
          status: 201,
          json: async () => ({ authorization_id: "auth-guard-401", quota: 2, plays_used: 0 }),
        };
      }
      if (url.includes("/api/media/stream/")) {
        return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
      }
      if (url.endsWith("/api/sessions/response")) {
        responseCalls++;
        // Delayed resolution
        await new Promise((r) => setTimeout(r, 50));
        return { ok: true, status: 200, json: async () => ({ status: "success" }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(<EvaluatePage />);
    await waitFor(() => expect(screen.getByText("SUS Intelligibility Task")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Play SUS audio" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause SUS audio" })).toBeInTheDocument());
    fireEvent.ended(document.querySelector("audio") as HTMLAudioElement);

    const submitBtn = screen.getByRole("button", { name: "Submit transcription and continue" });
    // Double click rapidly
    fireEvent.click(submitBtn);
    fireEvent.click(submitBtn);

    await waitFor(() => expect(responseCalls).toBe(1));
  });

  it("retries loading only when next-stimulus fails after submission is acknowledged", async () => {
    sessionStorage.setItem("session_token", "mock-session-token-12345");
    let nextStimulusCalls = 0;
    let responseCalls = 0;

    const fetchSpy = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/sessions/next-stimulus")) {
        nextStimulusCalls++;
        if (nextStimulusCalls === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              status: "active",
              test_name: "SUS Acknowledged Test",
              current_index: 1,
              total_stimuli: 1,
              stimulus: { id: 501, neutral_label: "SUS-ACK", kind: "sus" },
              mos_config: mockMosConfig,
            }),
          };
        } else if (nextStimulusCalls === 2) {
          // Failure on loading next step after response was acknowledged
          throw new TypeError("Failed to load next stimulus");
        } else {
          return {
            ok: true,
            status: 200,
            json: async () => ({ status: "completed", completion_text: "Session Completed" }),
          };
        }
      }
      if (url.endsWith("/api/sessions/sus/play-authorize")) {
        return {
          ok: true,
          status: 201,
          json: async () => ({ authorization_id: "auth-ack-501", quota: 2, plays_used: 0 }),
        };
      }
      if (url.includes("/api/media/stream/")) {
        return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
      }
      if (url.endsWith("/api/sessions/response")) {
        responseCalls++;
        return { ok: true, status: 200, json: async () => ({ status: "success" }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(<EvaluatePage />);
    await waitFor(() => expect(screen.getByText("SUS Intelligibility Task")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Play SUS audio" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause SUS audio" })).toBeInTheDocument());
    fireEvent.ended(document.querySelector("audio") as HTMLAudioElement);

    // Submit
    fireEvent.click(screen.getByRole("button", { name: "Submit transcription and continue" }));

    // Response was acknowledged (responseCalls === 1), but loadNextStimulus failed
    await waitFor(() => expect(screen.getByText("Network error loading content. Please check your connection.")).toBeInTheDocument());
    expect(responseCalls).toBe(1);

    // Clicking Retry in error card should ONLY retry loading, not resubmit response!
    const retryLoadBtn = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retryLoadBtn);

    await waitFor(() => expect(screen.getByText("Thank you.")).toBeInTheDocument());
    expect(responseCalls).toBe(1); // Still exactly 1!
    expect(nextStimulusCalls).toBe(3);
  });

  it("does not generate a new idempotency key automatically on HTTP 409", async () => {
    sessionStorage.setItem("session_token", "mock-session-token-12345");
    const capturedKeys: string[] = [];

    const fetchSpy = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/sessions/next-stimulus")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "active",
            test_name: "SUS 409 Test",
            current_index: 1,
            total_stimuli: 1,
            stimulus: { id: 601, neutral_label: "SUS-409", kind: "sus" },
            mos_config: mockMosConfig,
          }),
        };
      }
      if (url.endsWith("/api/sessions/sus/play-authorize")) {
        return {
          ok: true,
          status: 201,
          json: async () => ({ authorization_id: "auth-409-test", quota: 2, plays_used: 0 }),
        };
      }
      if (url.includes("/api/media/stream/")) {
        return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
      }
      if (url.endsWith("/api/sessions/response")) {
        const headers = init?.headers as Record<string, string>;
        capturedKeys.push(headers?.["Idempotency-Key"] || "");
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: "Idempotency key already used with different payload" }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(<EvaluatePage />);
    await waitFor(() => expect(screen.getByText("SUS Intelligibility Task")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Play SUS audio" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause SUS audio" })).toBeInTheDocument());
    fireEvent.ended(document.querySelector("audio") as HTMLAudioElement);

    // Submit
    fireEvent.click(screen.getByRole("button", { name: "Submit transcription and continue" }));

    // 409 error is displayed
    await waitFor(() => expect(screen.getByText("Idempotency key already used with different payload")).toBeInTheDocument());
    expect(capturedKeys).toHaveLength(1);

    // User attempts retry
    const retryBtn = screen.getAllByRole("button", { name: "Retry submission" })[0];
    fireEvent.click(retryBtn);

    await waitFor(() => expect(capturedKeys).toHaveLength(2));
    // Same key used, NOT a new key generated to bypass 409!
    expect(capturedKeys[1]).toBe(capturedKeys[0]);
  });
});
