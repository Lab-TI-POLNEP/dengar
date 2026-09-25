"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import PageShell from "@/components/PageShell";
import Button from "@/components/Button";
import Equalizer from "@/components/Equalizer";
import { CheckCircleIcon } from "@/components/Icons";
import Input from "@/components/Input";
import Checkbox from "@/components/Checkbox";
import Select from "@/components/Select";

const backendOrigin = process.env.NEXT_PUBLIC_BACKEND_ORIGIN ?? "";

type DemographicField = {
  key: string;
  label: string;
  field_type: string;
  required: boolean;
  options: string[];
};

type TestConfig = {
  test_id: number;
  name: string;
  consent_text: string;
  demographics: DemographicField[];
};

export default function GetStartedPage() {
  const router = useRouter();
  const [step, setStep] = useState<"code" | "info" | "consent" | "demographics" | "calibration" | "active">("code");
  
  // Input states
  const [accessCode, setAccessCode] = useState("");
  const [consentChecked, setConsentChecked] = useState(false);
  const [demoAnswers, setDemoAnswers] = useState<Record<string, string>>({});
  
  // Loading & error states
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  
  // Loaded test config
  const [testConfig, setTestConfig] = useState<TestConfig | null>(null);
  
  // Session details
  const [sessionToken, setSessionToken] = useState("");
  const [calibrationPlayCount, setCalibrationPlayCount] = useState(0);

  // Resume check on mount
  useEffect(() => {
    const token = sessionStorage.getItem("session_token");
    if (token) {
      setLoading(true);
      fetch(`${backendOrigin}/api/sessions/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      })
        .then((res) => {
          if (res.ok) {
            return res.json() as Promise<{
              session_token: string;
              name: string;
              test_id: number;
              requires_calibration: boolean;
              calibration_completed: boolean;
            }>;
          }
          throw new Error("Invalid session token");
        })
        .then((data) => {
          setSessionToken(data.session_token);
          setTestConfig({
            test_id: data.test_id,
            name: data.name,
            consent_text: "",
            demographics: [],
          });
          if (data.requires_calibration && !data.calibration_completed) {
            setStep("calibration");
          } else {
            router.push("/evaluate");
          }
        })
        .catch(() => {
          sessionStorage.removeItem("session_token");
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [router]);

  // Action: Code validation
  async function handleCodeSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg("");
    const cleanedCode = accessCode.trim().toUpperCase();
    if (!cleanedCode) {
      setErrorMsg("Access code is required.");
      return;
    }

    setLoading(true);
    try {
      const resp = await fetch(`${backendOrigin}/api/sessions/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_code: cleanedCode }),
      });
      const data = await resp.json() as { error?: string; test_id?: number; name?: string; consent_text?: string; demographics?: DemographicField[] };
      if (!resp.ok) {
        setErrorMsg(data.error ?? "Invalid or expired access code");
        return;
      }
      
      setTestConfig({
        test_id: data.test_id!,
        name: data.name!,
        consent_text: data.consent_text!,
        demographics: data.demographics!,
      });
      // Initialize demographic answers
      const initialAnswers: Record<string, string> = {};
      data.demographics?.forEach((df) => {
        initialAnswers[df.key] = "";
      });
      setDemoAnswers(initialAnswers);
      
      setStep("info");
    } catch {
      setErrorMsg("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  // Action: Consent accepted transition
  function handleConsentSubmit() {
    if (!consentChecked) {
      setErrorMsg("You must accept the informed consent terms to proceed.");
      return;
    }
    setErrorMsg("");
    if (testConfig && testConfig.demographics.length > 0) {
      setStep("demographics");
    } else {
      void handleStartSession({});
    }
  }

  // Action: Session start
  async function handleStartSession(answers: Record<string, string>) {
    setErrorMsg("");
    setValidationErrors({});
    
    // Client-side validations
    if (step === "demographics" && testConfig) {
      const errors: Record<string, string> = {};
      
      // normal_hearing is always required
      if (!answers["normal_hearing"] || !answers["normal_hearing"].trim()) {
        errors["normal_hearing"] = "Hearing status declaration is required.";
      }
      
      testConfig.demographics.forEach((df) => {
        if (df.key !== "normal_hearing" && df.required && (!answers[df.key] || !answers[df.key].trim())) {
          errors[df.key] = `${df.label} is required.`;
        }
      });
      
      if (Object.keys(errors).length > 0) {
        setValidationErrors(errors);
        return;
      }
    }

    setLoading(true);
    try {
      const resp = await fetch(`${backendOrigin}/api/sessions/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          access_code: accessCode.trim().toUpperCase(),
          consent_accepted: true,
          demographics: answers,
        }),
      });
      const data = await resp.json() as {
        error?: string;
        errors?: string[];
        session_token?: string;
        requires_calibration?: boolean;
        calibration_completed?: boolean;
      };
      if (!resp.ok) {
        if (data.errors) {
          setErrorMsg(data.errors.join(" "));
        } else {
          setErrorMsg(data.error ?? "Failed to start session.");
        }
        return;
      }
      
      const token = data.session_token!;
      setSessionToken(token);
      sessionStorage.setItem("session_token", token);
      if (data.requires_calibration && !data.calibration_completed) {
        setCalibrationPlayCount(0);
        setStep("calibration");
      } else {
        router.push("/evaluate");
      }
    } catch {
      setErrorMsg("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function handleExit() {
    sessionStorage.removeItem("session_token");
    setAccessCode("");
    setConsentChecked(false);
    setDemoAnswers({});
    setTestConfig(null);
    setSessionToken("");
    setErrorMsg("");
    setValidationErrors({});
    setCalibrationPlayCount(0);
    setStep("code");
  }

  return (
    <PageShell>
      {(loading || step === "active") && (
        <div style={{ textAlign: "center", padding: "2rem" }}>
          <p className="muted">Loading, please wait...</p>
        </div>
      )}

      {!loading && step === "code" && (
        <section className="hero" style={{ maxWidth: "480px", margin: "0 auto", padding: "2rem 0" }}>
          <p className="hero__eyebrow">Respondent Access</p>
          <h1 className="hero__title">Get Started.</h1>
          <p className="hero__copy">
            Please enter the 6-character access code provided by your study coordinator.
          </p>

          <form onSubmit={handleCodeSubmit} style={{ marginTop: "1.5rem" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              <label htmlFor="access-code-input" style={{ fontWeight: "bold" }}>Access Code</label>
              <Input
                id="access-code-input"
                type="text"
                variant="code"
                inputSize="lg"
                maxLength={6}
                value={accessCode}
                onChange={(e) => setAccessCode(e.target.value.toUpperCase())}
                placeholder="E.g. A9XF42"
              />
            </div>
            {errorMsg && (
              <p role="alert" className="form-error" style={{ marginTop: "1rem", textAlign: "center" }}>
                {errorMsg}
              </p>
            )}
            <div style={{ marginTop: "1.5rem" }}>
              <Button type="submit" style={{ width: "100%" }}>Verify Code</Button>
            </div>
          </form>
        </section>
      )}

      {!loading && step === "info" && testConfig && (
        <section className="hero" style={{ maxWidth: "640px", margin: "0 auto", padding: "2rem 0" }}>
          <p className="hero__eyebrow">Study Information</p>
          <h1 className="hero__title">{testConfig.name}</h1>
          <p className="hero__copy">
            You have successfully connected to the study. {"Let's"} configure your session parameters.
          </p>
          <div className="hero__actions" style={{ marginTop: "2rem" }}>
            <Button onClick={() => setStep("consent")}>Continue to Consent</Button>
            <Button variant="secondary" onClick={handleExit}>Exit</Button>
          </div>
        </section>
      )}

      {!loading && step === "consent" && testConfig && (
        <div style={{ maxWidth: "720px", margin: "0 auto", padding: "2rem 0" }}>
          <section className="hero">
            <p className="hero__eyebrow">Informed Consent</p>
            <h1 className="hero__title">Before you begin.</h1>
          </section>

          <div className="card" style={{ whiteSpace: "pre-wrap", margin: "1.5rem 0", padding: "1.5rem", border: "1px solid #e5e7eb", borderRadius: "8px", backgroundColor: "#fff" }}>
            {testConfig.consent_text}
          </div>

          <section className="section">
            <div className="card">
              <h2 className="card__title">Please confirm that:</h2>
              <ul className="check-list">
                <li>
                  <CheckCircleIcon />
                  You are using headphones or a quiet listening setup.
                </li>
                <li>
                  <CheckCircleIcon />
                  You understand your answers stay anonymous and are stored locally.
                </li>
                <li>
                  <CheckCircleIcon />
                  You have about 10 minutes available to complete the session.
                </li>
              </ul>
              
              <div style={{ marginTop: "1.5rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <Checkbox
                  id="consent-checkbox"
                  checked={consentChecked}
                  onChange={(e) => setConsentChecked(e.target.checked)}
                  label="I agree to participate in this study"
                />
              </div>

              {errorMsg && (
                <p role="alert" className="form-error" style={{ marginTop: "1rem" }}>
                  {errorMsg}
                </p>
              )}

              <div className="hero__actions" style={{ marginTop: "1.5rem" }}>
                <Button onClick={handleConsentSubmit} disabled={!consentChecked}>
                  Agree and continue
                </Button>
                <Button variant="secondary" onClick={handleExit}>Cancel</Button>
              </div>
            </div>
          </section>
        </div>
      )}

      {!loading && step === "demographics" && testConfig && (
        <div style={{ maxWidth: "640px", margin: "0 auto", padding: "2rem 0" }}>
          <section className="hero">
            <p className="hero__eyebrow">About You</p>
            <h1 className="hero__title">Demographic Questionnaire</h1>
            <p className="hero__copy">
              Please fill out these simple questions to help us evaluate the speech clips.
            </p>
          </section>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleStartSession(demoAnswers);
            }}
            style={{ marginTop: "2rem" }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
              {testConfig.demographics.map((df) => {
                const isRequired = df.required || df.key === "normal_hearing";
                return (
                  <div key={df.key} style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                    <label style={{ fontWeight: "bold" }}>
                      {df.label} {isRequired && <span style={{ color: "red" }}>*</span>}
                    </label>

                    {df.field_type === "radio" && df.options.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                        {df.options.map((opt) => (
                          <div key={opt} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                            <input
                              type="radio"
                              name={df.key}
                              id={`${df.key}-${opt}`}
                              checked={demoAnswers[df.key] === opt}
                              onChange={() => {
                                setDemoAnswers({ ...demoAnswers, [df.key]: opt });
                              }}
                            />
                            <label htmlFor={`${df.key}-${opt}`}>{opt}</label>
                          </div>
                        ))}
                      </div>
                    )}

                    {df.field_type === "select" && df.options.length > 0 && (
                      <Select
                        value={demoAnswers[df.key]}
                        onChange={(e) => setDemoAnswers({ ...demoAnswers, [df.key]: e.target.value })}
                      >
                        <option value="">-- Select an option --</option>
                        {df.options.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </Select>
                    )}

                    {df.field_type !== "radio" && df.field_type !== "select" && (
                      <Input
                        type="text"
                        value={demoAnswers[df.key]}
                        onChange={(e) => setDemoAnswers({ ...demoAnswers, [df.key]: e.target.value })}
                        placeholder={`Enter your ${df.label.toLowerCase()}`}
                      />
                    )}

                    {validationErrors[df.key] && (
                      <p role="alert" style={{ color: "red", fontSize: "0.85rem", marginTop: "0.25rem" }}>
                        {validationErrors[df.key]}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            {errorMsg && (
              <p role="alert" className="form-error" style={{ marginTop: "1.5rem" }}>
                {errorMsg}
              </p>
            )}

            <div className="hero__actions" style={{ marginTop: "2rem" }}>
              <Button type="submit" disabled={loading}>
                {loading ? "Starting session..." : "Start Session"}
              </Button>
              <Button variant="secondary" onClick={() => setStep("consent")}>Back</Button>
            </div>
          </form>
        </div>
      )}

      {!loading && step === "calibration" && testConfig && (
      <div style={{ maxWidth: "640px", margin: "0 auto", padding: "2rem 0" }}>
        <section className="hero">
          <p className="hero__eyebrow">Volume Calibration</p>
          <h1 className="hero__title">Set your listening level</h1>
          <p className="hero__copy">
            Play the sample and adjust your device volume to a comfortable listening level. You will listen at this volume for the whole test.
          </p>
        </section>

        <div className="card" style={{ marginTop: "2rem", padding: "2rem", borderRadius: "12px", border: "1px solid #e5e7eb", backgroundColor: "#fff" }}>
          <p style={{ margin: 0, fontWeight: 600 }}>Calibration sample</p>
          <audio
            controls
            preload="auto"
            src={`${backendOrigin}/api/sessions/calibration/stream?token=${encodeURIComponent(sessionToken)}`}
            onPlay={() => {
              if (sessionToken) {
                void fetch(`${backendOrigin}/api/sessions/calibration/play`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ token: sessionToken }),
                })
                  .then((res) => res.ok && res.json())
                  .then((data) => {
                    if (data && typeof data.calibration_play_count === "number") {
                      setCalibrationPlayCount(data.calibration_play_count);
                    }
                  })
                  .catch(() => {});
              }
            }}
            style={{ width: "100%", marginTop: "1rem" }}
          />

          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
            <span className="muted">Plays recorded: {calibrationPlayCount}</span>
            <button
              type="button"
              className="button button--primary"
              disabled={calibrationPlayCount < 1}
              onClick={async () => {
                setErrorMsg("");
                try {
                  const resp = await fetch(`${backendOrigin}/api/sessions/calibration/complete`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token: sessionToken }),
                  });
                  const data = await resp.json() as { error?: string };
                  if (!resp.ok) {
                    setErrorMsg(data.error ?? "Failed to complete calibration.");
                    return;
                  }
                  router.push("/evaluate");
                } catch {
                  setErrorMsg("Network error. Please try again.");
                }
              }}
              style={{ marginTop: 0 }}
            >
              Continue
            </button>
          </div>

          {errorMsg && (
            <p role="alert" className="form-error" style={{ marginTop: "1rem" }}>
              {errorMsg}
            </p>
          )}

          <div style={{ marginTop: "1.5rem" }}>
            <p className="muted" style={{ margin: 0 }}>
              The calibration audio does not count toward your test responses.
            </p>
          </div>
        </div>
      </div>
    )}

    {!loading && step === "active" && testConfig && (
        <section className="hero hero--split" style={{ padding: "2rem 0" }}>
          <div>
            <p className="hero__eyebrow">Session Active</p>
            <h1 className="hero__title">Success! Your session is active.</h1>
            <p className="hero__copy">
              Your anonymous evaluation session has started. This is the foundation milestone M6.1.
            </p>
            <div style={{ margin: "1.5rem 0", padding: "1rem", border: "1px solid #10b981", borderRadius: "8px", backgroundColor: "#ecfdf5" }}>
              <p style={{ fontWeight: "bold", color: "#065f46", marginBottom: "0.5rem" }}>Session details:</p>
              <ul style={{ listStyleType: "none", paddingLeft: 0, margin: 0 }}>
                <li><strong>Test Name:</strong> {testConfig.name}</li>
                <li style={{ wordBreak: "break-all" }}><strong>Session Token:</strong> <code style={{ fontFamily: "monospace" }}>{sessionToken}</code></li>
              </ul>
            </div>
            <div className="hero__actions">
              <Button onClick={handleExit}>Restart / Start another test</Button>
            </div>
          </div>

          <div className="preview-card" aria-label="Active session equalizer visualization">
            <div className="preview-card__header">
              <span>Session Active</span>
              <span className="preview-card__badge" style={{ backgroundColor: "#10b981" }}>READY</span>
            </div>
            <div className="preview-card__wave">
              <Equalizer />
            </div>
            <p className="preview-card__caption" style={{ textAlign: "center" }}>
              Visualization active. Press restart to clear token storage.
            </p>
          </div>
        </section>
      )}
    </PageShell>
  );
}
