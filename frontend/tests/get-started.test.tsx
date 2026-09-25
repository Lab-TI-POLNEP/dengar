import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import GetStartedPage from "../app/get-started/page";
import EvaluatePage from "../app/evaluate/page";

const pushMock = vi.fn();
const routerMock = { push: pushMock };
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

const mockDemographics = [
  {
    key: "normal_hearing",
    label: "Normal hearing status",
    field_type: "radio",
    required: true,
    options: ["Yes", "No"],
  },
  {
    key: "age",
    label: "Age range",
    field_type: "select",
    required: false,
    options: ["Under 18", "18-25", "Over 25"],
  },
];

function mockFetchApi(resolveSuccess = true, startSuccess = true, resumeSuccess = true) {
  return vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};

    if (url.endsWith("/api/sessions/resolve")) {
      if (resolveSuccess && body.access_code === "A9XF42") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            test_id: 42,
            name: "Listening Test 1",
            consent_text: "Please read this consent agreement carefully.",
            demographics: mockDemographics,
          }),
        };
      }
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: "Invalid or expired access code" }),
      };
    }

    if (url.endsWith("/api/sessions/start")) {
      if (startSuccess) {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            session_token: "mock-session-token-1234567890abcdef",
            test_id: 42,
            name: "Listening Test 1",
          }),
        };
      }
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: "Failed to start session" }),
      };
    }

    if (url.endsWith("/api/sessions/resume")) {
      if (resumeSuccess && body.token === "mock-session-token-1234567890abcdef") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            session_token: "mock-session-token-1234567890abcdef",
            test_id: 42,
            name: "Listening Test 1",
          }),
        };
      }
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: "Invalid session token" }),
      };
    }

    return { ok: false, status: 404, json: async () => ({}) };
  });
}

describe("GetStartedPage", () => {
  beforeEach(() => {
    pushMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("handles the complete multi-step wizard respondent flow", async () => {
    vi.stubGlobal("fetch", mockFetchApi());

    render(<GetStartedPage />);

    // Step 0: Access code form
    expect(screen.getByText("Respondent Access")).toBeInTheDocument();
    const input = screen.getByLabelText("Access Code");
    fireEvent.change(input, { target: { value: "a9xf42" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify Code" }));

    // Step 1: Info Page
    await waitFor(() => expect(screen.getByText("Listening Test 1")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Continue to Consent" }));

    // Step 2: Consent Page
    expect(screen.getByText("Please read this consent agreement carefully.")).toBeInTheDocument();
    const agreeButton = screen.getByRole("button", { name: "Agree and continue" });
    expect(agreeButton).toBeDisabled();

    // Accept consent
    const checkbox = screen.getByLabelText("I agree to participate in this study");
    fireEvent.click(checkbox);
    expect(agreeButton).toBeEnabled();
    fireEvent.click(agreeButton);

    // Step 3: Demographics Page
    await waitFor(() => expect(screen.getByText("Demographic Questionnaire")).toBeInTheDocument());
    
    // Submit without answers (validation error expected since normal_hearing is required)
    fireEvent.click(screen.getByRole("button", { name: "Start Session" }));
    await waitFor(() => expect(screen.getByText("Hearing status declaration is required.")).toBeInTheDocument());

    // Select required normal hearing answer
    const yesRadio = screen.getByLabelText("Yes");
    fireEvent.click(yesRadio);

    // Submit demographics successfully
    fireEvent.click(screen.getByRole("button", { name: "Start Session" }));

    // Step 4: Redirection to evaluation page
    expect(screen.queryByText("Your session is active")).not.toBeInTheDocument();
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/evaluate"));
    expect(sessionStorage.getItem("session_token")).toBe("mock-session-token-1234567890abcdef");
  });

  it("moves from demographics through calibration to the first stimulus", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      if (url.endsWith("/api/sessions/resolve")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            test_id: 42,
            name: "Calibrated Listening Test",
            consent_text: "Calibration consent",
            demographics: [mockDemographics[0]],
          }),
        };
      }
      if (url.endsWith("/api/sessions/start")) {
        expect(body.demographics).toEqual({ normal_hearing: "Yes" });
        return {
          ok: true,
          status: 201,
          json: async () => ({
            session_token: "calibrated-session-token",
            requires_calibration: true,
            calibration_completed: false,
          }),
        };
      }
      if (url.endsWith("/api/sessions/calibration/play")) {
        return { ok: true, status: 200, json: async () => ({ calibration_play_count: 1 }) };
      }
      if (url.endsWith("/api/sessions/calibration/complete")) {
        expect(body.token).toBe("calibrated-session-token");
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (url.endsWith("/api/sessions/next-stimulus")) {
        expect(body.token).toBe("calibrated-session-token");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "active",
            test_name: "Calibrated Listening Test",
            current_index: 1,
            total_stimuli: 1,
            stimulus: { id: 7, neutral_label: "S1", kind: "mos" },
            mos_config: { min: 1, max: 5, labels: ["1", "2", "3", "4", "5"] },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<GetStartedPage />);
    fireEvent.change(screen.getByLabelText("Access Code"), { target: { value: "A9XF42" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify Code" }));
    await waitFor(() => expect(screen.getByText("Calibrated Listening Test")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Continue to Consent" }));
    fireEvent.click(screen.getByLabelText("I agree to participate in this study"));
    fireEvent.click(screen.getByRole("button", { name: "Agree and continue" }));
    await waitFor(() => expect(screen.getByText("Demographic Questionnaire")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Yes"));
    fireEvent.click(screen.getByRole("button", { name: "Start Session" }));

    await waitFor(() => expect(screen.getByText("Set your listening level")).toBeInTheDocument());
    expect(pushMock).not.toHaveBeenCalledWith("/evaluate");
    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton).toBeDisabled();

    fireEvent.play(screen.getByText("Calibration sample").parentElement!.querySelector("audio")!);
    await waitFor(() => expect(screen.getByText("Plays recorded: 1")).toBeInTheDocument());
    fireEvent.click(continueButton);
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/evaluate"));

    render(<EvaluatePage />);
    await waitFor(() => expect(screen.getByText("Stimulus 1 of 1")).toBeInTheDocument());
    expect(screen.getByText("Calibrated Listening Test")).toBeInTheDocument();
    expect(screen.getByText("Listen and rate naturalness")).toBeInTheDocument();
  });

  it("shows generic error message when resolving invalid access code", async () => {
    vi.stubGlobal("fetch", mockFetchApi(false));

    render(<GetStartedPage />);

    const input = screen.getByLabelText("Access Code");
    fireEvent.change(input, { target: { value: "WRONG1" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify Code" }));

    await waitFor(() => expect(screen.getByText("Invalid or expired access code")).toBeInTheDocument());
  });

  it("resumes session directly if valid token exists in sessionStorage", async () => {
    sessionStorage.setItem("session_token", "mock-session-token-1234567890abcdef");
    vi.stubGlobal("fetch", mockFetchApi());

    render(<GetStartedPage />);

    // Jumps directly to evaluation redirect
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/evaluate"));
  });
});

