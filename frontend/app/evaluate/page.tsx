"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import PageShell from "@/components/PageShell";
import Button from "@/components/Button";
import Textarea from "@/components/Textarea";

const backendOrigin = process.env.NEXT_PUBLIC_BACKEND_ORIGIN ?? "";

type Stimulus = {
  id: number;
  neutral_label: string;
  kind: "mos" | "sus";
};

type MOSConfig = {
  min: number;
  max: number;
  labels: string[];
  prompt?: string;
};

type NextStimulusResponse = {
  status: "active" | "completed";
  message?: string;
  completion_text?: string;
  session_token?: string;
  test_id?: number;
  test_name?: string;
  current_index?: number;
  total_stimuli?: number;
  stimulus?: Stimulus;
  mos_config?: MOSConfig;
};

type SusPlaybackState = "idle" | "authorizing" | "playing" | "paused" | "completed" | "quota-exhausted" | "error";

type ApiErrorResponse = {
  error?: string;
};

export default function EvaluatePage() {
  const router = useRouter();
  const [sessionToken, setSessionToken] = useState("");
  
  // Loading & error states
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [susSubmitError, setSusSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  
  // Evaluation step states
  const [testName, setTestName] = useState("");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [totalStimuli, setTotalStimuli] = useState(0);
  const [stimulus, setStimulus] = useState<Stimulus | null>(null);
  const [mosConfig, setMosConfig] = useState<MOSConfig | null>(null);
  const [completed, setCompleted] = useState(false);
  const [completionMessage, setCompletionMessage] = useState("");
  
  // Input states per stimulus
  const [rating, setRating] = useState<number | null>(null);
  const [playCount, setPlayCount] = useState(0);
  const [transcription, setTranscription] = useState("");
  const [susAuthorizationId, setSusAuthorizationId] = useState<string | null>(null);
  const [susQuota, setSusQuota] = useState(0);
  const [susPlaysUsed, setSusPlaysUsed] = useState(0);
  const [susPlaybackState, setSusPlaybackState] = useState<SusPlaybackState>("idle");
  
  // Custom Audio Player state
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const susAudioRef = useRef<HTMLAudioElement | null>(null);
  const susObjectUrlRef = useRef<string | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const playbackOffsetRef = useRef(0);
  const authorizationInFlightRef = useRef(false);
  const initialLoadStartedRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // Fetch token and initial stimulus on mount
  useEffect(() => {
    if (initialLoadStartedRef.current) return;
    initialLoadStartedRef.current = true;
    const token = sessionStorage.getItem("session_token");
    if (!token) {
      router.push("/get-started");
      return;
    }
    setSessionToken(token);
    loadNextStimulus(token);
  }, [router]);

  // Time formatting helper
  function formatTime(time: number) {
    if (isNaN(time) || !isFinite(time)) return "0:00";
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
  }

  // Load next stimulus from server
  async function loadNextStimulus(token: string) {
    setLoading(true);
    setErrorMsg("");
    setSusSubmitError("");
    // Reset audio player states
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
    if (susAudioRef.current) {
      susAudioRef.current.pause();
      susAudioRef.current.src = "";
    }
    if (susObjectUrlRef.current) {
      URL.revokeObjectURL(susObjectUrlRef.current);
      susObjectUrlRef.current = null;
    }
    sourceRef.current?.stop();
    sourceRef.current = null;
    bufferRef.current = null;
    playbackOffsetRef.current = 0;
    setSusAuthorizationId(null);
    setTranscription("");
    setSusQuota(0);
    setSusPlaysUsed(0);
    setSusPlaybackState("idle");

    try {
      const resp = await fetch(`${backendOrigin}/api/sessions/next-stimulus`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await resp.json() as NextStimulusResponse;
      if (!resp.ok) {
        setErrorMsg((data as ApiErrorResponse).error ?? "Failed to fetch stimulus details.");
        return;
      }

      if (data.status === "completed") {
        setCompleted(true);
        setStimulus(null);
        if (data.completion_text) {
          setCompletionMessage(data.completion_text);
        }
      } else {
        setTestName(data.test_name ?? "");
        setCurrentIndex(data.current_index ?? 0);
        setTotalStimuli(data.total_stimuli ?? 0);
        setStimulus(data.stimulus ?? null);
        setMosConfig(data.mos_config ?? null);
        setRating(null);
        setPlayCount(0);
      }
    } catch {
      setErrorMsg("Network error loading content. Please check your connection.");
    } finally {
      setLoading(false);
    }
  }

  async function authorizeSusPlay() {
    const response = await fetch(`${backendOrigin}/api/sessions/sus/play-authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: sessionToken, stimulus_id: stimulus?.id }),
    });
    const data = await response.json() as { error?: string; authorization_id?: string; quota?: number; plays_used?: number };
    if (!response.ok || !data.authorization_id) {
      if (response.status === 429 && data.quota) {
        setSusQuota(data.quota);
        setSusPlaysUsed(data.quota);
      }
      const error = new Error(data.error ?? "Unable to authorize playback.");
      if (response.status === 429) error.name = "QuotaExceeded";
      throw error;
    }
    setSusAuthorizationId(data.authorization_id);
    setSusQuota(data.quota ?? 0);
    setSusPlaysUsed(data.plays_used ?? 0);
  }

  async function playSusAudio() {
    if (!stimulus || stimulus.kind !== "sus" || authorizationInFlightRef.current || susPlaybackState === "playing" || susPlaybackState === "quota-exhausted") return;
    authorizationInFlightRef.current = true;
    setSusPlaybackState("authorizing");
    try {
      await authorizeSusPlay();
      const response = await fetch(`${backendOrigin}/api/media/stream/${sessionToken}/${stimulus.id}`);
      if (!response.ok) throw new Error("Unable to load audio.");
      const objectUrl = URL.createObjectURL(new Blob([await response.arrayBuffer()]));
      if (susObjectUrlRef.current) URL.revokeObjectURL(susObjectUrlRef.current);
      susObjectUrlRef.current = objectUrl;
      const audio = susAudioRef.current;
      if (!audio) throw new Error("Unable to initialize audio player.");
      audio.src = objectUrl;
      audio.currentTime = playbackOffsetRef.current;
      audio.onended = () => {
        playbackOffsetRef.current = 0;
        setIsPlaying(false);
        setCurrentTime(0);
        setSusPlaysUsed((used) => used + 1);
        setSusPlaybackState("completed");
      };
      await audio.play();
      setIsPlaying(true);
      setSusPlaybackState("playing");
    } catch (error) {
      const quotaExceeded = error instanceof Error && error.name === "QuotaExceeded";
      setSusPlaybackState(quotaExceeded ? "quota-exhausted" : "error");
      if (!quotaExceeded) setErrorMsg(error instanceof Error ? error.message : "Unable to play audio.");
    } finally {
      authorizationInFlightRef.current = false;
    }
  }

  function pauseSusAudio() {
    const audio = susAudioRef.current;
    if (!audio || susPlaybackState !== "playing") return;
    playbackOffsetRef.current = audio.currentTime;
    audio.pause();
    setIsPlaying(false);
    setSusPlaybackState("paused");
  }

  // Handle play/pause action
  function handlePlayPause() {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().catch(() => {});
      setIsPlaying(true);
      setPlayCount((prev) => prev + 1);
    }
  }

  // Audio elements event handlers
  function handleTimeUpdate() {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  }

  function handleLoadedMetadata() {
    if (audioRef.current) {
      setDuration(audioRef.current.duration || 0);
    }
  }

  function handleAudioEnded() {
    setIsPlaying(false);
    setCurrentTime(0);
  }

  // Progress slider scrubbing handler
  function handleProgressChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = parseFloat(e.target.value);
    setCurrentTime(val);
    if (audioRef.current) {
      audioRef.current.currentTime = val;
    }
  }

  // Submit response
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stimulus) return;
    if (stimulus.kind === "mos" && rating === null) return;

    setSubmitting(true);
    setErrorMsg("");

    try {
      const resp = await fetch(`${backendOrigin}/api/sessions/response`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: sessionToken,
          stimulus_id: stimulus.id,
          rating: stimulus.kind === "mos" ? rating : undefined,
          play_count: stimulus.kind === "mos" ? playCount : undefined,
          authorization_id: stimulus.kind === "sus" ? susAuthorizationId : undefined,
          transcription: stimulus.kind === "sus" ? transcription : undefined,
        }),
      });
      const data = await resp.json() as { error?: string; status?: string };
      if (!resp.ok) {
        if (stimulus.kind === "sus") {
          setSusSubmitError(data.error ?? "Failed to submit response.");
          setSusPlaybackState("error");
        } else {
          setErrorMsg(data.error ?? "Failed to submit response.");
        }
        return;
      }
      
      // Load next step
      await loadNextStimulus(sessionToken);
    } catch {
      setErrorMsg("Network error saving response. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // Exit completion screen
  function handleFinish() {
    sessionStorage.removeItem("session_token");
    router.push("/get-started");
  }

  return (
    <PageShell>
      <div style={{ maxWidth: "680px", margin: "0 auto", width: "100%", padding: "2rem 0" }}>
        
        {loading && (
          <div style={{ textAlign: "center", padding: "4rem 0" }} role="status" aria-label="Loading stimulus">
            <p className="muted" style={{ fontSize: "1.1rem" }}>Loading evaluation step, please wait...</p>
          </div>
        )}

        {!loading && errorMsg && (
          <div className="card" role="alert" style={{ border: "1px solid #fca5a5", backgroundColor: "#fef2f2", padding: "2rem", borderRadius: "12px", textAlign: "center" }}>
            <h2 style={{ color: "#991b1b", marginTop: 0 }}>Error</h2>
            <p style={{ color: "#7f1d1d", marginBottom: "1.5rem" }}>{errorMsg}</p>
            <Button onClick={() => loadNextStimulus(sessionToken)}>Retry</Button>
          </div>
        )}

        {!loading && !errorMsg && completed && (
          <section className="hero" style={{ textAlign: "center", padding: "3rem 0" }}>
            <p className="hero__eyebrow">Session Completed</p>
            <h1 className="hero__title">Thank you.</h1>
            <p className="hero__copy" style={{ fontSize: "1.1rem", marginBottom: "2.5rem" }}>
              {completionMessage || "Your speech evaluation session is finished. Your answers have been safely saved."}
            </p>
            <Button onClick={handleFinish}>Exit Session</Button>
          </section>
        )}

        {!loading && !errorMsg && !completed && stimulus && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
              <div>
                <span className="eyebrow">{testName}</span>
                <h1 style={{ margin: "0.25rem 0 0", fontSize: "1.75rem", fontWeight: "800", letterSpacing: "-0.03em" }}>
                  Speech Evaluation
                </h1>
              </div>
              <span className="muted" style={{ fontWeight: "600", fontSize: "0.95rem" }} aria-label={`Progress: Stimulus ${currentIndex} of ${totalStimuli}`}>
                Stimulus {currentIndex} of {totalStimuli}
              </span>
            </div>

            {stimulus.kind === "mos" && (
              <form onSubmit={handleSubmit} className="card" style={{ padding: "2rem", border: "1px solid var(--color-border)", borderRadius: "16px", backgroundColor: "#fff", boxShadow: "var(--shadow-card)" }}>
                <h2 style={{ fontSize: "1.25rem", fontWeight: "700", marginTop: 0, marginBottom: "0.5rem" }}>
                  Listen and rate naturalness
                </h2>
                <p className="muted" style={{ marginTop: 0, marginBottom: "1.25rem" }}>
                  Stimulus {stimulus.neutral_label}
                </p>
                
                {/* Audio Asset Stream URL */}
                <audio
                  ref={audioRef}
                  src={`${backendOrigin}/api/media/stream/${sessionToken}/${stimulus.id}`}
                  onTimeUpdate={handleTimeUpdate}
                  onLoadedMetadata={handleLoadedMetadata}
                  onEnded={handleAudioEnded}
                  preload="auto"
                />

                {/* Custom Audio Player Controls */}
                <div style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "1.25rem",
                  padding: "1rem 1.25rem",
                  backgroundColor: "var(--color-surface-soft)",
                  borderRadius: "12px",
                  border: "1px solid var(--color-border)",
                  marginBottom: "2rem"
                }}>
                  <button
                    type="button"
                    onClick={handlePlayPause}
                    style={{
                      width: "3.25rem",
                      height: "3.25rem",
                      borderRadius: "50%",
                      backgroundColor: "var(--color-primary)",
                      color: "#ffffff",
                      border: "none",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                      boxShadow: "0 4px 10px rgba(79, 70, 229, 0.2)",
                      transition: "background-color 150ms ease"
                    }}
                    aria-label={isPlaying ? "Pause audio" : "Play audio"}
                  >
                    {isPlaying ? (
                      /* Pause Icon */
                      <svg style={{ width: "1.25rem", height: "1.25rem" }} viewBox="0 0 24 24" fill="currentColor">
                        <rect x="6" y="4" width="4" height="16" rx="1" />
                        <rect x="14" y="4" width="4" height="16" rx="1" />
                      </svg>
                    ) : (
                      /* Play Icon */
                      <svg style={{ width: "1.25rem", height: "1.25rem" }} viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    )}
                  </button>

                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                    <input
                      type="range"
                      min={0}
                      max={duration || 100}
                      value={currentTime}
                      onChange={handleProgressChange}
                      style={{
                        width: "100%",
                        height: "5px",
                        cursor: "pointer",
                        accentColor: "var(--color-primary)"
                      }}
                      aria-label="Audio progress timeline"
                    />
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "var(--color-muted)", fontWeight: "500" }}>
                      <span>{formatTime(currentTime)}</span>
                      <span>{formatTime(duration)}</span>
                    </div>
                  </div>
                </div>

                {/* Likert Scale */}
                {mosConfig && (
                  <div style={{ marginBottom: "2rem" }}>
                    <p style={{ fontWeight: "600", fontSize: "0.95rem", color: "var(--color-text)", marginBottom: "0.75rem" }}>
                      {mosConfig.prompt || "How natural does this voice sound to you?"}
                    </p>
                    
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }} role="group" aria-label="MOS Likert Rating Scale">
                      {Array.from({ length: mosConfig.max - mosConfig.min + 1 }, (_, index) => {
                        const score = mosConfig.min + index;
                        const label = mosConfig.labels[index] || "";
                        const isActive = rating === score;
                        return (
                          <button
                            key={score}
                            type="button"
                            onClick={() => setRating(score)}
                            className={`mos-scale__dot ${isActive ? "mos-scale__dot--active" : ""}`}
                            style={{
                              flex: "1 1 0px",
                              minWidth: "75px",
                              height: "auto",
                              padding: "0.85rem var(--space-1)",
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.25rem",
                              alignItems: "center",
                              cursor: "pointer",
                              transition: "all 150ms ease"
                            }}
                            aria-label={`Rate ${score}: ${label}`}
                            aria-pressed={isActive}
                          >
                            <span style={{ fontSize: "1.25rem", fontWeight: "700" }}>{score}</span>
                            <span style={{ fontSize: "0.7rem", fontWeight: "500", textAlign: "center", opacity: 0.9 }}>
                              {label}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <Button
                    type="submit"
                    disabled={rating === null || submitting}
                    aria-label="Submit rating and continue"
                  >
                    {submitting ? "Saving..." : "Next"}
                  </Button>
                </div>
              </form>
            )}

            {stimulus.kind === "sus" && (
              <form onSubmit={handleSubmit} className="card" style={{ padding: "2.5rem", border: "1px solid var(--color-border)", borderRadius: "16px", backgroundColor: "#fff", boxShadow: "var(--shadow-card)", textAlign: "center" }}>
                <h2 style={{ fontSize: "1.5rem", fontWeight: "800", marginTop: 0, marginBottom: "0.75rem" }}>
                  SUS Intelligibility Task
                </h2>
                <div style={{
                  position: "relative",
                  padding: "1.5rem",
                  background: "linear-gradient(135deg, var(--color-surface-soft), #eef2ff)",
                  borderRadius: "16px",
                  border: "1px solid var(--color-border)",
                  marginBottom: "2rem"
                }}>
                  <p style={{ margin: "0 0 .35rem", fontWeight: "800", color: "var(--color-text)" }}>Listen carefully</p>
                  <p className="muted" role="status" style={{ margin: 0, fontWeight: "500" }}>
                    {susPlaybackState === "quota-exhausted" ? "Playback limit reached for this sentence." : `Listen at least once before continuing. Plays used: ${susPlaysUsed} of ${susQuota || "..."}.`}
                  </p>
                </div>
                <audio ref={susAudioRef} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)} preload="auto" />
                <p className="muted" style={{ margin: "0 0 1rem", fontWeight: 600 }}>Stimulus {stimulus.neutral_label}</p>
                <button type="button" onClick={isPlaying ? pauseSusAudio : playSusAudio} disabled={susPlaybackState === "authorizing" || susPlaybackState === "quota-exhausted"} aria-label={isPlaying ? "Pause SUS audio" : "Play SUS audio"} style={{ width: "100%", minHeight: "3.25rem", border: 0, borderRadius: "12px", background: susPlaybackState === "quota-exhausted" ? "#cbd5e1" : "var(--color-primary)", color: "#fff", fontWeight: 800, fontSize: "1rem", cursor: susPlaybackState === "quota-exhausted" ? "not-allowed" : "pointer", boxShadow: "0 8px 18px rgba(79, 70, 229, .2)" }}>
                  {susPlaybackState === "authorizing" ? "Authorizing..." : isPlaying ? "Pause" : "Play"}
                </button>
                <label htmlFor="sus-transcription" style={{ display: "block", textAlign: "left", margin: "1.5rem 0 1rem" }}>Transcription</label>
                <Textarea id="sus-transcription" value={transcription} onChange={(event) => setTranscription(event.target.value)} rows={4} />
                {susSubmitError && (
                  <p role="alert" style={{ color: "#991b1b", margin: "1rem 0", fontWeight: 600 }}>{susSubmitError}</p>
                )}
                <div style={{ display: "flex", justifyContent: "center" }}>
                  <Button
                    type="submit"
                    disabled={
                      submitting ||
                      !transcription.trim() ||
                      (!susAuthorizationId && susPlaybackState !== "quota-exhausted") ||
                      !(
                        susPlaybackState === "completed" ||
                        susPlaybackState === "quota-exhausted"
                      )
                    }
                    aria-label="Submit transcription and continue"
                  >
                    {submitting ? "Saving..." : "Continue"}
                  </Button>
                </div>
              </form>
            )}

          </div>
        )}

      </div>
    </PageShell>
  );
}

