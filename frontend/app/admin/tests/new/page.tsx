"use client";

import { FormEvent, Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { adminRequest, getCsrfToken } from "@/lib/admin-api";
import Input from "@/components/Input";
import Checkbox from "@/components/Checkbox";
import Select from "@/components/Select";
import "./wizard.css";

const backendOrigin = process.env.NEXT_PUBLIC_BACKEND_ORIGIN ?? "";

const steps = ["Setup", "Audio", "Demographics", "Review"] as const;

const stepNotes = [
  "Name the test and select the test type.",
  "Configure test settings and select audio clips from the Audio Library.",
  "Configure demographic fields collected from respondents for this test. Normal hearing status is mandatory.",
  "Review all configuration and audio selections before creating or saving the test.",
] as const;

export type TestType = "mos" | "sus" | "combined";
export type TestLanguage = "id" | "en" | "zh";

type LoadedConfig = {
  name?: string;
  test_type?: TestType;
  language?: TestLanguage;
  audio?: Record<string, unknown>;
  pages?: Array<Record<string, unknown>>;
  mos?: {
    min: number;
    max: number;
    labels?: string[];
    prompt?: string;
    scale_id?: number;
    scale_name?: string;
  };
  sus?: { quota: number };
  calibration_audio_ref?: string;
};

type MOSScalePresetItem = {
  id: number;
  name: string;
  minimum: number;
  maximum: number;
  labels: string[];
  prompt: string;
};

type AudioAssetItem = {
  id: string;
  original_filename: string;
  content_type: string;
  size_bytes: number;
  status: string;
  engine_id?: number | null;
  reference_transcription?: string | null;
};

type AudioSelection = {
  key: string;
  assetId: string;
  filename: string;
  kind: "mos" | "sus";
  engineId: number | null;
  referenceTranscription?: string | null;
};

type EngineItem = {
  id: number;
  name: string;
  description?: string;
};

type DemographicItem = {
  key: string;
  label: string;
  field_type: string;
  required: boolean;
  enabled: boolean;
  options?: string[];
};

type StimulusAssignment = {
  audio_ref: string;
  engine_id: number | null;
  kind: "mos" | "sus";
  neutral_label?: string;
};

type TextTemplateItem = {
  id: number;
  kind: string;
  version: number;
  content: string;
};

const emptyPages: Array<Record<string, unknown>> = [
  { kind: "consent", title: "Informed consent" },
  { kind: "completion", title: "Session complete" },
];

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

function serializeAudioMap(audio: Record<string, unknown>): string[] {
  const keys = Object.keys(audio);
  if (keys.length === 0) return ["audio: {}"];
  const lines = ["audio:"];
  for (const key of keys) {
    lines.push(`  ${key}: ${yamlQuote(String(audio[key]))}`);
  }
  return lines;
}

function serializePages(
  testType: TestType,
  selection: AudioSelection[],
  existingPages: Array<Record<string, unknown>>
): string[] {
  const lines = ["pages:"];
  lines.push('  - kind: consent');
  lines.push('    title: "Informed consent"');

  const demoPage = existingPages.find((p) => p.kind === "demographics");
  if (demoPage && Array.isArray(demoPage.fields)) {
    lines.push('  - kind: demographics');
    lines.push(`    title: ${yamlQuote(String(demoPage.title ?? "About you"))}`);
    lines.push(`    fields: [${demoPage.fields.map((f) => yamlQuote(String(f))).join(", ")}]`);
  }

  const mosClips = selection.filter((s) => s.kind === "mos");
  const susClips = selection.filter((s) => s.kind === "sus");

  if (testType === "mos" || testType === "combined") {
    if (mosClips.length > 0) {
      lines.push('  - kind: mos');
      lines.push('    title: "Rate each sample"');
      lines.push('    stimuli:');
      for (const clip of mosClips) {
        lines.push(`      - audio_ref: ${yamlQuote(clip.key)}`);
      }
    }
  }

  if (testType === "sus" || testType === "combined") {
    if (susClips.length > 0) {
      lines.push('  - kind: sus');
      lines.push('    title: "Semantically Unpredictable Sentences"');
      lines.push('    stimuli:');
      for (const clip of susClips) {
        lines.push(`      - audio_ref: ${yamlQuote(clip.key)}`);
      }
    }
  }

  lines.push('  - kind: completion');
  lines.push('    title: "Session complete"');
  return lines;
}

function serializeConfig(
  name: string,
  testType: TestType,
  audio: Record<string, unknown>,
  selection: AudioSelection[],
  existingPages: Array<Record<string, unknown>>,
  mosMin: number,
  mosMax: number,
  susQuota: number,
  existingLabels: string[],
  calibrationAudioRef: string | null,
  mosPrompt?: string,
  scaleId?: number | null,
  scaleName?: string | null,
  language: TestLanguage = "id"
): string {
  const labels =
    existingLabels.length === mosMax - mosMin + 1
      ? existingLabels
      : Array.from({ length: mosMax - mosMin + 1 }, (_, index) => `${mosMin + index}`);

  const lines = [
    `name: ${yamlQuote(name)}`,
    `test_type: ${testType}`,
    `language: ${language}`,
    ...serializeAudioMap(audio),
  ];

  if (calibrationAudioRef) {
    lines.push(`calibration_audio_ref: ${yamlQuote(calibrationAudioRef)}`);
  }

  const pageLines = serializePages(testType, selection, existingPages);

  const mosLines: string[] = [];
  if (testType === "mos" || testType === "combined") {
    mosLines.push("mos:");
    mosLines.push(`  min: ${mosMin}`);
    mosLines.push(`  max: ${mosMax}`);
    mosLines.push(`  labels: [${labels.map((l) => yamlQuote(l)).join(", ")}]`);
    if (mosPrompt) {
      mosLines.push(`  prompt: ${yamlQuote(mosPrompt)}`);
    }
    if (scaleId) {
      mosLines.push(`  scale_id: ${scaleId}`);
    }
    if (scaleName) {
      mosLines.push(`  scale_name: ${yamlQuote(scaleName)}`);
    }
  }

  const susLines: string[] = [];
  if (testType === "sus" || testType === "combined") {
    susLines.push("sus:");
    susLines.push(`  quota: ${susQuota}`);
  }

  return [
    ...lines,
    ...pageLines,
    ...mosLines,
    ...susLines,
    "",
  ].join("\n");
}

function audioKeyFor(assetId: string): string {
  return `clip-${assetId.slice(0, 8)}`;
}

function NewTestWizard() {
  const searchParams = useSearchParams();
  const editId = searchParams.get("id");
  const parsedEditId = editId ? Number(editId) : NaN;

  const [step, setStep] = useState(0);
  const [testId, setTestId] = useState<number | null>(
    Number.isInteger(parsedEditId) && parsedEditId > 0 ? parsedEditId : null
  );
  const [name, setName] = useState("");
  const [testType, setTestType] = useState<TestType>("mos");
  const [language, setLanguage] = useState<TestLanguage>("id");
  const [scalePresets, setScalePresets] = useState<MOSScalePresetItem[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string>("");
  const [mosPrompt, setMosPrompt] = useState<string>("Rate the naturalness of the speech on a scale from 1 to 5.");
  const [scaleId, setScaleId] = useState<number | null>(null);
  const [scaleName, setScaleName] = useState<string | null>(null);
  const [mosMin, setMosMin] = useState(1);
  const [mosMax, setMosMax] = useState(5);
  const [susQuota, setSusQuota] = useState(2);
  const [audioMap, setAudioMap] = useState<Record<string, unknown>>({});
  const [pages, setPages] = useState<Array<Record<string, unknown>>>(emptyPages);
  const [mosLabels, setMosLabels] = useState<string[]>(["Bad", "Poor", "Fair", "Good", "Excellent"]);
  const [calibrationAudioRef, setCalibrationAudioRef] = useState<string>("");
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [loadingDraft, setLoadingDraft] = useState(Boolean(editId));
  const [loadError, setLoadError] = useState("");
  const [assets, setAssets] = useState<AudioAssetItem[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [selection, setSelection] = useState<AudioSelection[]>([]);
  const [selectionReady, setSelectionReady] = useState(false);
  const [engines, setEngines] = useState<EngineItem[]>([]);
  const [stimuli, setStimuli] = useState<StimulusAssignment[]>([]);
  const [demographicItems, setDemographicItems] = useState<DemographicItem[]>([]);
  const [loadingDemographics, setLoadingDemographics] = useState(false);
  const [demographicsReady, setDemographicsReady] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [finalized, setFinalized] = useState(false);
  const [finalizationError, setFinalizationError] = useState("");
  const [draftMissing, setDraftMissing] = useState(false);
  const [testStatus, setTestStatus] = useState<string>("");
  const isPublished = testStatus === "published";
  const [wasPublished, setWasPublished] = useState(false);

  // Filters for Audio Library
  const [audioSearch, setAudioSearch] = useState("");
  const [susFilter, setSusFilter] = useState<"all" | "ready" | "missing">("all");

  // Load MOS Scale Presets
  useEffect(() => {
    let cancelled = false;
    async function loadPresets() {
      const response = await adminRequest("/admin/api/mos-scales");
      if (cancelled) return;
      if (response.ok) {
        const payload = (await response.json()) as { items?: MOSScalePresetItem[] };
        const items = payload.items ?? [];
        if (!cancelled) {
          setScalePresets(items);
        }
      }
    }
    void loadPresets();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load Engines
  useEffect(() => {
    let cancelled = false;
    async function loadEngines() {
      const response = await adminRequest("/admin/api/engines");
      if (cancelled) return;
      if (response.ok) {
        const payload = (await response.json()) as { items?: EngineItem[] };
        if (!cancelled) setEngines(payload.items ?? []);
      }
    }
    void loadEngines();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load Text Templates
  const [textTemplates, setTextTemplates] = useState<TextTemplateItem[]>([]);
  useEffect(() => {
    let cancelled = false;
    async function loadTemplates() {
      const response = await adminRequest("/admin/api/text-templates");
      if (cancelled) return;
      if (response.ok) {
        const payload = (await response.json()) as { items?: TextTemplateItem[] };
        if (!cancelled) setTextTemplates(payload.items ?? []);
      }
    }
    void loadTemplates();
    return () => {
      cancelled = true;
    };
  }, []);

  const consentTemplate = useMemo(() => {
    return (
      textTemplates
        .filter((t) => t.kind.toLowerCase() === "consent")
        .sort((a, b) => b.version - a.version)[0] ?? null
    );
  }, [textTemplates]);

  const completionTemplate = useMemo(() => {
    return (
      textTemplates
        .filter((t) => t.kind.toLowerCase() === "completion")
        .sort((a, b) => b.version - a.version)[0] ?? null
    );
  }, [textTemplates]);

  // Load draft if editId is provided
  useEffect(() => {
    if (!editId) return;
    let cancelled = false;
    async function load() {
      const response = await adminRequest(`/admin/api/tests/${editId}`);
      if (response.status === 401) {
        window.location.href = "/admin/signin";
        return;
      }
      if (!response.ok) {
        if (!cancelled) {
          setLoadError("Could not load this test.");
          setDraftMissing(true);
          setTestId(null);
        }
        setLoadingDraft(false);
        return;
      }
      const payload = (await response.json()) as { status: string; config: LoadedConfig | null };
      if (cancelled) return;
      if (payload.status !== "draft" && payload.status !== "published") {
        setLoadError("Only draft or published tests can be edited here.");
        setDraftMissing(true);
        setTestId(null);
        setLoadingDraft(false);
        return;
      }
      setTestStatus(payload.status);
      if (payload.status === "published") {
        setWasPublished(true);
      }
      setDraftMissing(false);
      const config = payload.config;
      if (config) {
        setName(config.name ?? "");
        if (config.language && ["id", "en", "zh"].includes(config.language)) {
          setLanguage(config.language as TestLanguage);
        }
        if (config.test_type) {
          setTestType(config.test_type === ("mos_sus" as string) ? "combined" : config.test_type);
        } else {
          const hasMos = Boolean(config.mos || config.pages?.some((p) => p.kind === "mos"));
          const hasSus = Boolean(config.sus || config.pages?.some((p) => p.kind === "sus"));
          if (hasMos && hasSus) {
            setTestType("combined");
          } else if (hasSus) {
            setTestType("sus");
          } else {
            setTestType("mos");
          }
        }
        setAudioMap(config.audio ?? {});
        setPages(config.pages ?? emptyPages);
        setCalibrationAudioRef(config.calibration_audio_ref ?? "");
        if (config.mos) {
          setMosMin(config.mos.min);
          setMosMax(config.mos.max);
          setMosLabels(config.mos.labels ?? []);
          if (config.mos.prompt) setMosPrompt(config.mos.prompt);
          if (config.mos.scale_id) {
            setScaleId(config.mos.scale_id);
            setSelectedPresetId(String(config.mos.scale_id));
          }
          if (config.mos.scale_name) setScaleName(config.mos.scale_name);
        }
        if (config.sus) setSusQuota(config.sus.quota);
      }

      // Also load existing stimuli
      const stimuliResp = await adminRequest(`/admin/api/tests/${editId}/stimuli`);
      if (stimuliResp.ok && !cancelled) {
        const stimPayload = (await stimuliResp.json()) as { items?: StimulusAssignment[] };
        setStimuli(stimPayload.items ?? []);
      }

      setLoadingDraft(false);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [editId]);

  // Load Audio Library assets on Audio or Review step
  useEffect(() => {
    if (step !== 1 && step !== 3) return;
    let cancelled = false;
    async function loadAssets() {
      setAssetsLoading(true);
      const response = await adminRequest("/admin/api/audio");
      if (cancelled) return;
      if (response.status === 401) {
        window.location.href = "/admin/signin";
        return;
      }
      if (response.ok) {
        const payload = (await response.json()) as { items?: AudioAssetItem[] };
        setAssets(payload.items ?? []);
      }
      setAssetsLoading(false);
    }
    void loadAssets();
    return () => {
      cancelled = true;
    };
  }, [step]);

  // Sync initial selection when assets and audioMap / stimuli are ready
  useEffect(() => {
    if (selectionReady || assets.length === 0) return;
    const existing = Object.entries(audioMap);
    if (existing.length > 0) {
      const initial: AudioSelection[] = existing.map(([key, value]) => {
        const asset = assets.find((item) => item.id === value);
        const stim = stimuli.find((s) => s.audio_ref === key);
        let kind: "mos" | "sus" = "mos";
        if (stim?.kind) {
          kind = stim.kind;
        } else if (testType === "sus") {
          kind = "sus";
        }
        return {
          key,
          assetId: String(value),
          filename: asset?.original_filename ?? "(missing asset)",
          kind,
          engineId: asset?.engine_id ?? stim?.engine_id ?? null,
          referenceTranscription: asset?.reference_transcription ?? null,
        };
      });
      setSelection(initial);
    }
    setSelectionReady(true);
  }, [assets, audioMap, stimuli, testType, selectionReady]);

  // Handle Preset Select
  function handlePresetSelect(presetIdStr: string) {
    setSelectedPresetId(presetIdStr);
    const preset = scalePresets.find((p) => String(p.id) === presetIdStr);
    if (preset) {
      setScaleId(preset.id);
      setScaleName(preset.name);
      setMosMin(preset.minimum);
      setMosMax(preset.maximum);
      setMosLabels([...preset.labels]);
      setMosPrompt(preset.prompt);
    } else {
      setScaleId(null);
      setScaleName(null);
    }
  }

  // STEP 0: Save Setup
  async function saveSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrors([]);
    const trimmed = name.trim();
    const clientErrors: string[] = [];
    if (!trimmed) clientErrors.push("Name is required.");
    if (!testType) clientErrors.push("Test type is required.");
    if (clientErrors.length > 0) {
      setErrors(clientErrors);
      return;
    }
    setSaving(true);
    const csrf = await getCsrfToken();
    const yaml = serializeConfig(
      trimmed,
      testType,
      audioMap,
      selection,
      pages,
      mosMin,
      mosMax,
      susQuota,
      mosLabels,
      calibrationAudioRef || null,
      mosPrompt.trim(),
      scaleId,
      scaleName,
      language
    );
    let response = testId
      ? await adminRequest(`/admin/api/tests/${testId}`, {
          method: "PATCH",
          headers: { "X-CSRF-Token": csrf },
          body: JSON.stringify({ yaml }),
        })
      : await adminRequest("/admin/api/tests", {
          method: "POST",
          headers: { "X-CSRF-Token": csrf },
          body: JSON.stringify({ yaml }),
        });
    if (!testId && response.status === 404) {
      response = await adminRequest("/admin/api/tests/import", {
        method: "POST",
        headers: { "X-CSRF-Token": csrf },
        body: JSON.stringify({ yaml }),
      });
    }
    setSaving(false);
    const payload = (await response.json().catch(() => ({}))) as {
      id?: number;
      errors?: string[];
    };
    if (!response.ok) {
      setErrors(payload.errors ?? ["Could not save the draft."]);
      return;
    }
    setTestStatus("draft");
    if (!testId) {
      if (payload.id) {
        setTestId(payload.id);
      } else {
        setErrors(["Could not determine the draft ID after saving."]);
        return;
      }
    }
    setStep(1);
  }

  // Toggle asset in selection with explicit task kind ("mos" or "sus")
  function toggleAssetKind(asset: AudioAssetItem, targetKind: "mos" | "sus") {
    setSelection((current) => {
      const exists = current.find((item) => item.assetId === asset.id);
      if (exists) {
        if (exists.kind === targetKind) {
          // Deselect
          const removedKey = audioKeyFor(asset.id);
          if (removedKey === calibrationAudioRef) {
            setCalibrationAudioRef("");
          }
          return current.filter((item) => item.assetId !== asset.id);
        } else {
          // Switch kind
          return current.map((item) =>
            item.assetId === asset.id ? { ...item, kind: targetKind } : item
          );
        }
      }
      // Add new selection
      return [
        ...current,
        {
          key: audioKeyFor(asset.id),
          assetId: asset.id,
          filename: asset.original_filename,
          kind: targetKind,
          engineId: asset.engine_id ?? null,
          referenceTranscription: asset.reference_transcription ?? null,
        },
      ];
    });
  }

  // STEP 1: Save Audio & Config
  async function saveAudio() {
    if (!testId) {
      setErrors(["Draft must be saved before configuring audio."]);
      return;
    }
    setErrors([]);

    const clientErrors: string[] = [];
    if (selection.length === 0) {
      clientErrors.push("At least one audio clip must be selected.");
    }
    if ((testType === "mos" || testType === "combined") && !scaleId) {
      clientErrors.push("Please select a MOS scale preset.");
    }
    if (testType === "sus" || testType === "combined") {
      if (!susQuota || susQuota < 1) {
        clientErrors.push("SUS playback quota must be at least 1.");
      }
    }

    // Check SUS clips have reference transcriptions
    const susSelections = selection.filter((s) => s.kind === "sus");
    const missingTranscriptions = susSelections.filter(
      (s) => !s.referenceTranscription || !s.referenceTranscription.trim()
    );
    if (missingTranscriptions.length > 0) {
      clientErrors.push(
        `All SUS audio clips must have a reference transcription in the Audio Library. Missing: ${missingTranscriptions
          .map((m) => m.filename)
          .join(", ")}.`
      );
    }

    const missingEngines = selection.filter((item) => item.engineId === null);
    if (missingEngines.length > 0) {
      clientErrors.push(
        `All selected audio clips must have an engine assigned. Missing: ${missingEngines
          .map((item) => item.filename)
          .join(", ")}.`
      );
    }

    if (clientErrors.length > 0) {
      setErrors(clientErrors);
      return;
    }

    setSaving(true);
    const csrf = await getCsrfToken();
    const nextAudioMap = Object.fromEntries(selection.map((item) => [item.key, item.assetId]));

    // 1. Save Config YAML
    const yaml = serializeConfig(
      name.trim(),
      testType,
      nextAudioMap,
      selection,
      pages,
      mosMin,
      mosMax,
      susQuota,
      mosLabels,
      calibrationAudioRef || null,
      mosPrompt.trim(),
      scaleId,
      scaleName,
      language
    );

    const patchResponse = await adminRequest(`/admin/api/tests/${testId}`, {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrf },
      body: JSON.stringify({ yaml }),
    });

    if (!patchResponse.ok) {
      setSaving(false);
      const payload = (await patchResponse.json().catch(() => ({}))) as {
        errors?: string[];
        error?: string;
      };
      setErrors(payload.errors ?? [payload.error ?? "Could not save audio configuration."]);
      return;
    }

    // 2. Save Stimuli Assignments
    const stimuliPayload = selection.map((item) => ({
      audio_ref: item.key,
      engine_id: item.engineId,
      kind: item.kind,
    }));

    const stimuliResponse = await adminRequest(`/admin/api/tests/${testId}/stimuli`, {
      method: "PUT",
      headers: { "X-CSRF-Token": csrf },
      body: JSON.stringify({ stimuli: stimuliPayload }),
    });

    setSaving(false);

    let stimuliResult: { items?: StimulusAssignment[]; errors?: string[]; error?: string } = {};
    try {
      stimuliResult = (await stimuliResponse.json()) as typeof stimuliResult;
    } catch {
      // ignore
    }

    if (!stimuliResponse.ok) {
      setErrors(stimuliResult.errors ?? [stimuliResult.error ?? "Could not save stimuli assignments."]);
      return;
    }

    setTestStatus("draft");
    setAudioMap(nextAudioMap);
    setStimuli(stimuliResult.items ?? []);
    setStep(2);
  }

  // Load Demographics
  useEffect(() => {
    if ((step !== 2 && step !== 3) || !testId || demographicsReady) return;
    let cancelled = false;
    async function loadDemographics() {
      setLoadingDemographics(true);
      const url = `/admin/api/tests/${testId}/demographics`;
      const response = await adminRequest(url);
      if (cancelled) return;
      if (response.status === 401) {
        window.location.href = "/admin/signin";
        return;
      }
      if (response.ok) {
        const payload = (await response.json()) as { items?: DemographicItem[] };
        if (!cancelled) setDemographicItems(payload.items ?? []);
      }
      if (!cancelled) {
        setLoadingDemographics(false);
        setDemographicsReady(true);
      }
    }
    void loadDemographics();
    return () => {
      cancelled = true;
    };
  }, [step, testId, demographicsReady]);

  function toggleDemographic(key: string) {
    setDemographicItems((current) =>
      current.map((item) => {
        if (item.key === key) {
          if (key === "normal_hearing") return item;
          return { ...item, enabled: !item.enabled };
        }
        return item;
      })
    );
  }

  // STEP 2: Save Demographics
  async function saveDemographics() {
    if (!testId) {
      setErrors(["Draft must be saved before configuring demographics."]);
      return;
    }
    setErrors([]);
    setSaving(true);
    const csrf = await getCsrfToken();
    const enabledKeys = demographicItems.filter((item) => item.enabled).map((item) => item.key);
    const response = await adminRequest(`/admin/api/tests/${testId}/demographics`, {
      method: "PUT",
      headers: { "X-CSRF-Token": csrf },
      body: JSON.stringify({ keys: enabledKeys }),
    });
    setSaving(false);
    let result: { items?: DemographicItem[]; errors?: string[]; error?: string } = {};
    try {
      result = (await response.json()) as typeof result;
    } catch {
      // ignore
    }
    if (!response.ok) {
      setErrors(result.errors ?? [result.error ?? "Could not save demographics."]);
      return;
    }
    setTestStatus("draft");
    setDemographicItems(result.items ?? []);
    setStep(3);
  }

  // Review step issues validation
  const reviewIssues = useMemo(() => {
    const issues: Array<{ message: string; step: number }> = [];
    if (!name.trim()) {
      issues.push({ message: "Test name is required.", step: 0 });
    }
    if (selection.length === 0) {
      issues.push({ message: "At least one audio clip must be selected.", step: 1 });
    }
    if (testType === "mos" || testType === "combined") {
      if (!scaleId) {
        issues.push({ message: "A MOS scale preset must be selected.", step: 1 });
      }
    }
    if (testType === "sus" || testType === "combined") {
      if (!susQuota || susQuota < 1) {
        issues.push({ message: "SUS playback quota must be at least 1.", step: 1 });
      }
    }
    if (selection.length > 0) {
      const missingEngine = selection.filter((item) => item.engineId === null);
      if (missingEngine.length > 0) {
        issues.push({
          message: `Every selected clip must have an engine assigned in the Audio Library (${missingEngine.length} unassigned).`,
          step: 1,
        });
      }
      const missingTranscription = selection.filter(
        (item) => item.kind === "sus" && (!item.referenceTranscription || !item.referenceTranscription.trim())
      );
      if (missingTranscription.length > 0) {
        issues.push({
          message: `Every SUS audio clip must have a reference transcription in the Audio Library (${missingTranscription.length} missing).`,
          step: 1,
        });
      }

      // Check task and stimuli kind consistency
      if (testType === "mos" && selection.some((item) => item.kind !== "mos")) {
        issues.push({ message: "A MOS test cannot contain SUS audio clips.", step: 1 });
      }
      if (testType === "sus" && selection.some((item) => item.kind !== "sus")) {
        issues.push({ message: "A SUS test cannot contain MOS audio clips.", step: 1 });
      }
      if (testType === "combined") {
        if (!selection.some((item) => item.kind === "mos")) {
          issues.push({ message: "A combined test must include at least one MOS audio clip.", step: 1 });
        }
        if (!selection.some((item) => item.kind === "sus")) {
          issues.push({ message: "A combined test must include at least one SUS audio clip.", step: 1 });
        }
      }
    }
    if (!demographicItems.some((item) => item.key === "normal_hearing")) {
      issues.push({ message: "Normal hearing field must be configured.", step: 2 });
    }
    return issues;
  }, [name, selection, testType, scaleId, susQuota, demographicItems]);

  const reviewDisabled = finalizing || reviewIssues.length > 0 || draftMissing;

  // Filtered assets for audio library picker
  const filteredAssets = useMemo(() => {
    const query = audioSearch.trim().toLowerCase();
    return assets.filter((asset) => {
      const matchesSearch =
        !query ||
        asset.original_filename.toLowerCase().includes(query) ||
        asset.id.toLowerCase().includes(query) ||
        (engines.find((e) => e.id === asset.engine_id)?.name ?? "").toLowerCase().includes(query) ||
        (asset.reference_transcription ?? "").toLowerCase().includes(query);

      const hasTranscription = Boolean(asset.reference_transcription?.trim());
      const matchesSusFilter =
        susFilter === "all" ||
        (susFilter === "ready" && hasTranscription) ||
        (susFilter === "missing" && !hasTranscription);

      return matchesSearch && matchesSusFilter;
    });
  }, [assets, audioSearch, engines, susFilter]);

  if (loadingDraft) {
    return (
      <section className="admin-page">
        <p className="eyebrow">Studies</p>
        <h1>New test</h1>
        <p className="admin-lede">Loading draft…</p>
      </section>
    );
  }

  return (
    <section className="admin-page">
      <p className="eyebrow">Studies</p>
      <h1>New test</h1>
      <p className="admin-lede">
        {testId === null
          ? "Four steps to a publishable test."
          : isPublished
          ? `Editing published test #${testId}.`
          : `Editing draft #${testId}.`}
      </p>
      {loadError && (
        <p role="alert" className="form-error">
          {loadError}
        </p>
      )}
      {draftMissing && !loadingDraft && (
        <p className="muted" style={{ marginTop: "var(--space-2)" }}>
          This test cannot be edited. Please return to the tests list and open a valid test.
        </p>
      )}

      {/* Stepper */}
      <ol className="admin-steps" aria-label="Wizard steps">
        {steps.map((label, index) => {
          const isActive = index === step;
          const isClickable = Boolean(testId) && !isActive;
          return (
            <li
              key={label}
              className={`${isActive ? "is-active" : ""} ${isClickable ? "is-clickable" : ""}`}
              onClick={
                isClickable
                  ? () => {
                      setErrors([]);
                      setStep(index);
                    }
                  : undefined
              }
              style={isClickable ? { cursor: "pointer" } : undefined}
              role={isClickable ? "button" : undefined}
              tabIndex={isClickable ? 0 : undefined}
              onKeyDown={
                isClickable
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setErrors([]);
                        setStep(index);
                      }
                    }
                  : undefined
              }
            >
              {label}
            </li>
          );
        })}
      </ol>

      {/* STEP 0: SETUP */}
      {step === 0 && (
        <form
          onSubmit={saveSetup}
          className="admin-panel admin-form"
          style={{ marginTop: "var(--space-3)" }}
        >
          <h2>Setup</h2>
          <p className="muted" style={{ margin: 0 }}>
            {stepNotes[0]}
          </p>
          <label>
            Test name
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. English Naturalness MOS Pilot"
              required
            />
          </label>
          <label>
            Test type
            <Select
              value={testType}
              onChange={(event) => setTestType(event.target.value as TestType)}
              required
            >
              <option value="mos">MOS (Mean Opinion Score)</option>
              <option value="sus">SUS (Semantically Unpredictable Sentences)</option>
              <option value="combined">MOS + SUS (Combined)</option>
            </Select>
          </label>
          <label>
            Audio language
            <Select
              value={language}
              onChange={(event) => setLanguage(event.target.value as TestLanguage)}
              required
            >
              <option value="id">Indonesian (Bahasa Indonesia)</option>
              <option value="en">English</option>
              <option value="zh">Chinese / Mandarin (中文)</option>
            </Select>
          </label>

          {/* Participant Text Templates Section */}
          <div
            style={{
              marginTop: "var(--space-2)",
              padding: "1rem",
              borderRadius: "var(--radius-sm, 6px)",
              background: "var(--color-surface-soft, #f9fafb)",
              border: "1px solid var(--color-border, #e5e7eb)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem", flexWrap: "wrap", gap: "0.5rem" }}>
              <strong style={{ fontSize: "0.9rem", color: "var(--color-foreground)" }}>
                Participant Text Templates
              </strong>
              <a
                href="/admin/master-data/text-templates"
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: "0.8rem", color: "var(--color-primary, #4f46e5)", textDecoration: "none", fontWeight: 600 }}
              >
                Manage Text Templates in Master Data ↗
              </a>
            </div>
            <p className="muted" style={{ fontSize: "0.82rem", margin: "0 0 0.75rem 0" }}>
              These standardized statements are presented to respondents during the study.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "0.75rem" }}>
              <div style={{ padding: "0.75rem", background: "#fff", borderRadius: "6px", border: "1px solid var(--color-border, #eee)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.3rem" }}>
                  <span style={{ fontSize: "0.75rem", fontWeight: 600, padding: "0.1rem 0.45rem", borderRadius: "4px", background: "#eff6ff", color: "#1d4ed8" }}>
                    Informed Consent
                  </span>
                  {consentTemplate && (
                    <span style={{ fontSize: "0.72rem", color: "#6b7280" }}>
                      v{consentTemplate.version}
                    </span>
                  )}
                </div>
                {consentTemplate ? (
                  <p style={{ fontSize: "0.8rem", color: "#374151", margin: 0, maxHeight: "60px", overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                    {consentTemplate.content}
                  </p>
                ) : (
                  <p className="review-missing" style={{ fontSize: "0.8rem", margin: 0 }}>
                    Not set
                  </p>
                )}
              </div>

              <div style={{ padding: "0.75rem", background: "#fff", borderRadius: "6px", border: "1px solid var(--color-border, #eee)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.3rem" }}>
                  <span style={{ fontSize: "0.75rem", fontWeight: 600, padding: "0.1rem 0.45rem", borderRadius: "4px", background: "#f0fdf4", color: "#15803d" }}>
                    Study Completion
                  </span>
                  {completionTemplate && (
                    <span style={{ fontSize: "0.72rem", color: "#6b7280" }}>
                      v{completionTemplate.version}
                    </span>
                  )}
                </div>
                {completionTemplate ? (
                  <p style={{ fontSize: "0.8rem", color: "#374151", margin: 0, maxHeight: "60px", overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                    {completionTemplate.content}
                  </p>
                ) : (
                  <p className="review-missing" style={{ fontSize: "0.8rem", margin: 0 }}>
                    Not set
                  </p>
                )}
              </div>
            </div>
          </div>
          {errors.length > 0 && (
            <ul role="alert" className="form-error" style={{ margin: 0 }}>
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          )}
          <button type="submit" className="admin-button admin-button--primary" disabled={saving}>
            {saving ? "Saving…" : "Save and continue"}
          </button>
        </form>
      )}

      {/* STEP 1: AUDIO & CONFIGURATION */}
      {step === 1 && (
        <div className="admin-panel wizard-audio" style={{ marginTop: "var(--space-3)" }}>
          <div className="wizard-step__header">
            <div>
              <h2>Audio &amp; Task Configuration</h2>
              <p className="muted" style={{ margin: 0 }}>
                {stepNotes[1]}
              </p>
            </div>
            <div className="wizard-step__meta">
              <span>
                {selection.length} clip{selection.length === 1 ? "" : "s"} selected
              </span>
            </div>
          </div>

          {assetsLoading ? (
            <p className="muted" style={{ marginTop: "var(--space-3)" }}>
              Loading audio library…
            </p>
          ) : assets.length === 0 ? (
            <p className="muted" style={{ marginTop: "var(--space-3)" }}>
              No audio assets yet. Upload files in the Audio Library first, then return here.
            </p>
          ) : (
            <>
              {/* Search & Filter Toolbar */}
              <div className="wizard-audio-filter" style={{ marginTop: "var(--space-3)" }}>
                <Input
                  value={audioSearch}
                  onChange={(e) => setAudioSearch(e.target.value)}
                  placeholder="Filter audio by filename, engine, or transcription…"
                  style={{ flex: "1 1 300px" }}
                />
                {(testType === "sus" || testType === "combined") && (
                  <Select
                    value={susFilter}
                    onChange={(e) => setSusFilter(e.target.value as "all" | "ready" | "missing")}
                    style={{ width: "220px" }}
                  >
                    <option value="all">All Transcriptions</option>
                    <option value="ready">Ready Transcription</option>
                    <option value="missing">Missing Transcription</option>
                  </Select>
                )}
              </div>

              {/* MOS CONFIGURATION & SELECTION (if MOS or Combined) */}
              {(testType === "mos" || testType === "combined") && (
                <section className="wizard-section">
                  <h3 className="wizard-section__title">MOS Configuration</h3>
                  <p className="wizard-section__description">
                    Select a MOS scale preset and choose audio clips evaluated for naturalness/quality.
                  </p>

                  <div className="admin-form mos-configuration__controls">
                    <label>
                      MOS Scale Preset
                      <Select
                        value={selectedPresetId}
                        onChange={(e) => handlePresetSelect(e.target.value)}
                      >
                        <option value="">
                          No preset selected
                        </option>
                        {scalePresets.map((preset) => (
                          <option key={preset.id} value={preset.id}>
                            {preset.name} ({preset.minimum}–{preset.maximum})
                          </option>
                        ))}
                      </Select>
                    </label>
                    {scalePresets.length === 0 && (
                      <p className="form-error" style={{ fontSize: "0.85rem", margin: 0 }}>
                        No MOS scale presets defined. Please create a scale in Master Data &gt; MOS Scales.
                      </p>
                    )}
                    <div className="mos-preset-summary" aria-live="polite">
                      {selectedPresetId ? (
                        <>
                          <div className="mos-preset-summary__prompt">
                            <span className="mos-preset-summary__label">Rating prompt</span>
                            <p>{mosPrompt}</p>
                          </div>
                          <div className="mos-preset-summary__range" aria-label="MOS value range">
                            <div>
                              <span className="mos-preset-summary__label">Min value</span>
                              <strong>{mosMin}</strong>
                            </div>
                            <div>
                              <span className="mos-preset-summary__label">Max value</span>
                              <strong>{mosMax}</strong>
                            </div>
                          </div>
                        </>
                      ) : (
                        <p className="mos-preset-summary__empty">No preset selected. Choose a scale preset to see its rating prompt and value range.</p>
                      )}
                    </div>
                  </div>

                  <h4 style={{ margin: "var(--space-2) 0" }}>Select MOS Audio Clips</h4>
                  <ul className="wizard-audio__list">
                    {filteredAssets.map((asset) => {
                      const selected = selection.find((item) => item.assetId === asset.id);
                      const isSelectedForMos = selected?.kind === "mos";
                      const isSelectedOther = selected && selected.kind !== "mos";
                      const engine = engines.find((e) => e.id === asset.engine_id);

                      return (
                        <li key={asset.id} className={isSelectedForMos ? "is-selected" : ""}>
                          <div className="wizard-audio-item__header">
                            <label>
                              <Checkbox
                                checked={isSelectedForMos}
                                disabled={isSelectedOther}
                                onChange={() => toggleAssetKind(asset, "mos")}
                              />
                              <span className="wizard-audio__name">{asset.original_filename}</span>
                              {isSelectedForMos && <span className="count">{selected.key}</span>}
                            </label>
                            <div className="wizard-audio-item__meta">
                              {engine ? (
                                <span className="wizard-badge wizard-badge--engine">Engine: {engine.name}</span>
                              ) : (
                                <span className="wizard-badge wizard-badge--no-engine">No Engine Assigned</span>
                              )}
                              {isSelectedOther && (
                                <span className="wizard-badge wizard-badge--no-transcription">
                                  Assigned to {selected.kind.toUpperCase()}
                                </span>
                              )}
                            </div>
                          </div>
                          <audio
                            controls
                            preload="none"
                            src={`${backendOrigin}/admin/api/audio/${asset.id}/stream`}
                          />
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              {/* SUS CONFIGURATION & SELECTION (if SUS or Combined) */}
              {(testType === "sus" || testType === "combined") && (
                <section className="wizard-section">
                  <h3 className="wizard-section__title">SUS Configuration</h3>
                  <p className="wizard-section__description">
                    Set playback quota and select audio clips evaluated for sentence intelligibility.
                  </p>

                  <div className="admin-form" style={{ maxWidth: "400px", marginBottom: "var(--space-3)" }}>
                    <label>
                      Playback Quota (times respondent can play each clip)
                      <Input
                        type="number"
                        min={1}
                        value={susQuota}
                        onChange={(e) => setSusQuota(Math.max(1, Number(e.target.value) || 1))}
                        required
                      />
                    </label>
                  </div>

                  <h4 style={{ margin: "var(--space-2) 0" }}>Select SUS Audio Clips</h4>
                  <ul className="wizard-audio__list">
                    {filteredAssets.map((asset) => {
                      const selected = selection.find((item) => item.assetId === asset.id);
                      const isSelectedForSus = selected?.kind === "sus";
                      const isSelectedOther = selected && selected.kind !== "sus";
                      const engine = engines.find((e) => e.id === asset.engine_id);
                      const hasTranscription = Boolean(asset.reference_transcription?.trim());

                      return (
                        <li key={asset.id} className={isSelectedForSus ? "is-selected" : ""}>
                          <div className="wizard-audio-item__header">
                            <label>
                              <Checkbox
                                checked={isSelectedForSus}
                                disabled={isSelectedOther}
                                onChange={() => toggleAssetKind(asset, "sus")}
                              />
                              <span className="wizard-audio__name">{asset.original_filename}</span>
                              {isSelectedForSus && <span className="count">{selected.key}</span>}
                            </label>
                            <div className="wizard-audio-item__meta">
                              {engine ? (
                                <span className="wizard-badge wizard-badge--engine">Engine: {engine.name}</span>
                              ) : (
                                <span className="wizard-badge wizard-badge--no-engine">No Engine Assigned</span>
                              )}
                              {hasTranscription ? (
                                <span className="wizard-badge wizard-badge--transcription">Transcription Ready</span>
                              ) : (
                                <span className="wizard-badge wizard-badge--no-transcription">
                                  Missing Transcription
                                </span>
                              )}
                              {isSelectedOther && (
                                <span className="wizard-badge wizard-badge--no-transcription">
                                  Assigned to {selected.kind.toUpperCase()}
                                </span>
                              )}
                            </div>
                          </div>
                          {hasTranscription && (
                            <div className="wizard-transcription-preview">
                              <strong>Reference:</strong> “{asset.reference_transcription}”
                            </div>
                          )}
                          <audio
                            controls
                            preload="none"
                            src={`${backendOrigin}/admin/api/audio/${asset.id}/stream`}
                          />
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}
            </>
          )}

          {errors.length > 0 && (
            <ul role="alert" className="form-error" style={{ margin: "var(--space-3) 0 0" }}>
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          )}

          {assets.length > 0 && (
            <div className="admin-toolbar" style={{ marginTop: "var(--space-3)" }}>
              <button
                type="button"
                className="admin-button admin-button--primary"
                onClick={saveAudio}
                disabled={saving || assetsLoading}
              >
                {saving ? "Saving…" : "Save and continue"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* STEP 2: DEMOGRAPHICS */}
      {step === 2 && (
        <div className="admin-panel wizard-step" style={{ marginTop: "var(--space-3)" }}>
          <h2>Demographics</h2>
          <p className="muted" style={{ margin: 0 }}>
            {stepNotes[2]}
          </p>

          {loadingDemographics ? (
            <p className="muted" style={{ marginTop: "var(--space-2)" }}>
              Loading demographics field configuration…
            </p>
          ) : (
            <div className="wizard-demographics-grid">
              <div className="wizard-demographics-list">
                <h3>Select demographic fields</h3>
                {demographicItems.map((item) => {
                  const isMandatory = item.key === "normal_hearing";
                  return (
                    <label
                      key={item.key}
                      className={`wizard-demographics-card ${isMandatory ? "is-mandatory" : ""}`}
                    >
                      <Checkbox
                        checked={item.enabled || isMandatory}
                        disabled={isMandatory}
                        onChange={() => toggleDemographic(item.key)}
                      />
                      <div>
                        <strong>{item.label}</strong>
                        {isMandatory && (
                          <span className="muted" style={{ display: "block", fontSize: "0.85rem" }}>
                            Mandatory: cannot be disabled
                          </span>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>

              <div className="wizard-demographics-preview">
                <h3>Respondent Form Preview</h3>
                <div style={{ pointerEvents: "none", opacity: 0.8 }}>
                  {demographicItems
                    .filter((item) => item.enabled || item.key === "normal_hearing")
                    .map((item) => {
                      const isMandatory = item.key === "normal_hearing";
                      const isSelect =
                        item.field_type === "select" || item.key === "age" || item.key === "gender";
                      const isRadio =
                        item.field_type === "radio" ||
                        item.key === "native_speaker" ||
                        item.key === "normal_hearing" ||
                        item.key === "experience";
                      const isRequired = item.required || isMandatory;

                      let fieldOptions: string[] =
                        Array.isArray(item.options) && item.options.length > 0 ? item.options : [];
                      if (fieldOptions.length === 0) {
                        if (item.key === "age")
                          fieldOptions = ["Under 18", "18–25 years", "26–35 years", "36–45 years", "Over 45"];
                        else if (item.key === "gender") fieldOptions = ["Female", "Male", "Prefer not to say"];
                        else if (item.key === "native_speaker" || item.key === "experience")
                          fieldOptions = ["Yes", "No"];
                        else if (item.key === "normal_hearing")
                          fieldOptions = ["Yes, I declare I have normal hearing", "No"];
                      }

                      return (
                        <div key={item.key} className="wizard-preview-field">
                          <span className="wizard-preview-label">
                            {item.label} {isRequired ? "*" : "(optional)"}
                          </span>
                          {isSelect && (
                            <Select defaultValue="" disabled>
                              <option value="" disabled>
                                Select {item.label.toLowerCase()}
                              </option>
                              {fieldOptions.map((opt, i) => (
                                <option key={i} value={opt}>
                                  {opt}
                                </option>
                              ))}
                            </Select>
                          )}
                          {isRadio && (
                            <div style={{ display: "flex", gap: "1rem", marginTop: "0.25rem", flexWrap: "wrap" }}>
                              {fieldOptions.map((opt, i) => (
                                <label key={i} style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                                  <input type="radio" checked={false} readOnly /> {opt}
                                </label>
                              ))}
                            </div>
                          )}
                          {item.field_type === "number" && (
                            <Input type="number" placeholder="Enter number..." disabled inputSize="sm" />
                          )}
                          {!isSelect && !isRadio && item.field_type !== "number" && (
                            <Input type="text" placeholder="Enter answer..." disabled inputSize="sm" />
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>
            </div>
          )}

          {errors.length > 0 && (
            <ul role="alert" className="form-error" style={{ margin: "0.5rem 0 0" }}>
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          )}

          <div className="admin-toolbar" style={{ marginTop: "var(--space-2)" }}>
            <button
              type="button"
              className="admin-button admin-button--primary"
              onClick={saveDemographics}
              disabled={saving || loadingDemographics}
            >
              {saving ? "Saving…" : "Save and continue"}
            </button>
          </div>
        </div>
      )}

      {/* STEP 3: REVIEW */}
      {step === 3 && (
        <div className="admin-panel" style={{ marginTop: "var(--space-3)" }}>
          <h2>Review</h2>
          <p className="muted" style={{ margin: 0 }}>
            {stepNotes[3]}
          </p>

          <div className="review-cards" style={{ marginTop: "var(--space-3)" }}>
            {/* Column 1: Setup & Demographics */}
            <div className="review-cards-column">
              {/* Setup Summary Card */}
              <section className="review-card">
                <div className="review-card__header">
                  <h3>Setup</h3>
                  <button
                    type="button"
                    className="admin-button admin-button--secondary review-card__edit"
                    onClick={() => setStep(0)}
                  >
                    Edit
                  </button>
                </div>
                <dl className="review-card__dl">
                  <dt>Test name</dt>
                  <dd>{name || <span className="review-missing">Not set</span>}</dd>
                  <dt>Test type</dt>
                  <dd>
                    {testType === "mos"
                      ? "MOS"
                      : testType === "sus"
                      ? "SUS"
                      : "MOS + SUS"}
                  </dd>
                  <dt>Audio language</dt>
                  <dd>
                    {language === "id"
                      ? "Indonesian"
                      : language === "en"
                      ? "English"
                      : "Chinese / Mandarin"}
                  </dd>
                </dl>
              </section>

              {/* Demographics Summary Card */}
              <section className="review-card">
                <div className="review-card__header">
                  <h3>Demographics</h3>
                  <button
                    type="button"
                    className="admin-button admin-button--secondary review-card__edit"
                    onClick={() => setStep(2)}
                  >
                    Edit
                  </button>
                </div>
                <ul className="review-card__list">
                  {demographicItems.map((item) => {
                    const isMandatory = item.key === "normal_hearing";
                    const isEnabled = item.enabled || isMandatory;
                    return (
                      <li key={item.key} className="review-demo-item">
                        <span className="review-demo-item__label">{item.label}</span>
                        <div className="review-demo-item__tags">
                          {isMandatory && (
                            <span className="review-badge review-badge--mandatory">mandatory</span>
                          )}
                          {!isMandatory && item.required && isEnabled && (
                            <span className="review-badge review-badge--required">Required</span>
                          )}
                          {isEnabled ? (
                            !isMandatory && !item.required && (
                              <span className="review-badge review-badge--ready">Optional</span>
                            )
                          ) : (
                            <span className="review-badge review-badge--disabled review-missing">Disabled</span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            </div>

            {/* Column 2: Configuration Card */}
            <section className="review-card">
              <div className="review-card__header">
                <h3>Configuration</h3>
                <button
                  type="button"
                  className="admin-button admin-button--secondary review-card__edit"
                  onClick={() => setStep(1)}
                >
                  Edit
                </button>
              </div>
              <dl className="review-card__dl">
                {(testType === "mos" || testType === "combined") && (
                  <>
                    <dt>MOS Scale</dt>
                    <dd>{scaleName || <span className="review-missing">Not selected</span>}</dd>
                    <dt>MOS range</dt>
                    <dd>
                      {mosMin} to {mosMax}
                    </dd>
                    <dt>Labels</dt>
                    <dd>{mosLabels.length ? mosLabels.join(", ") : "Default numeric labels"}</dd>
                    <dt>Rating Prompt</dt>
                    <dd className="review-prompt-text">{mosPrompt}</dd>
                  </>
                )}
                {(testType === "sus" || testType === "combined") && (
                  <>
                    <dt>SUS Quota</dt>
                    <dd>{susQuota} play{susQuota === 1 ? "" : "s"}</dd>
                  </>
                )}
              </dl>
            </section>

            {/* Column 3: Text Templates Card */}
            <section className="review-card">
              <div className="review-card__header">
                <h3>Text Templates</h3>
                <a
                  href="/admin/master-data/text-templates"
                  target="_blank"
                  rel="noreferrer"
                  className="admin-button admin-button--secondary review-card__edit"
                  style={{ textDecoration: "none", fontSize: "0.8rem" }}
                >
                  Manage ↗
                </a>
              </div>
              <dl className="review-card__dl">
                <dt>Informed Consent</dt>
                <dd>
                  {consentTemplate ? (
                    <>
                      <span className="wizard-badge" style={{ background: "#eff6ff", color: "#1d4ed8", marginRight: "0.35rem" }}>
                        v{consentTemplate.version}
                      </span>
                      <span style={{ fontSize: "0.82rem", color: "var(--color-muted)" }}>
                        Mandatory participant consent
                      </span>
                    </>
                  ) : (
                    <span className="review-missing">Not set</span>
                  )}
                </dd>
                <dt>Completion</dt>
                <dd>
                  {completionTemplate ? (
                    <>
                      <span className="wizard-badge" style={{ background: "#f0fdf4", color: "#15803d", marginRight: "0.35rem" }}>
                        v{completionTemplate.version}
                      </span>
                      <span style={{ fontSize: "0.82rem", color: "var(--color-muted)" }}>
                        Final debriefing screen
                      </span>
                    </>
                  ) : (
                    <span className="review-missing">Not set</span>
                  )}
                </dd>
              </dl>
            </section>

            {/* Audio & Stimuli Card - Full width */}
            <section className="review-card review-card--wide">
              <div className="review-card__header">
                <h3>Audio &amp; Stimuli</h3>
                <button
                  type="button"
                  className="admin-button admin-button--secondary review-card__edit"
                  onClick={() => setStep(1)}
                >
                  Edit
                </button>
              </div>
              <div className="review-table-wrapper">
                <table className="review-table">
                  <thead>
                    <tr>
                      <th>Neutral label</th>
                      <th>Audio key</th>
                      <th>Filename</th>
                      <th>Kind</th>
                      <th>Engine</th>
                      <th>Transcription</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selection.length > 0 ? (
                      selection.map((item, index) => {
                        const engine = engines.find((e) => e.id === item.engineId);
                        const hasTranscription = Boolean(item.referenceTranscription?.trim());

                        return (
                          <tr key={item.key}>
                            <td><strong>{`S${index + 1}`}</strong></td>
                            <td><code>{item.key}</code></td>
                            <td className="review-table__filename">{item.filename}</td>
                            <td>
                              <span className="wizard-badge" style={{ textTransform: "uppercase" }}>
                                {item.kind}
                              </span>
                            </td>
                            <td>
                              {engine ? (
                                <span className="wizard-badge wizard-badge--engine">{engine.name}</span>
                              ) : (
                                <span className="wizard-badge wizard-badge--no-engine">Unassigned</span>
                              )}
                            </td>
                            <td>
                              {item.kind === "sus" ? (
                                hasTranscription ? (
                                  <span className="review-badge review-badge--ready" title={item.referenceTranscription ?? ""}>
                                    Ready: “{item.referenceTranscription}”
                                  </span>
                                ) : (
                                  <span className="review-badge review-badge--missing">Missing</span>
                                )
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan={6} className="review-missing">
                          No audio clips selected
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          {/* Issues list banner */}
          {reviewIssues.length > 0 && (
            <div className="review-issues" style={{ marginTop: "var(--space-3)" }}>
              <strong>Fix these issues before creating the test:</strong>
              <ul className="review-issues__list">
                {reviewIssues.map((issue) => (
                  <li key={`${issue.step}-${issue.message}`} className="review-issue-item">
                    <span>{issue.message}</span>
                    <button
                      type="button"
                      className="admin-button admin-button--secondary review-issue-item__link"
                      onClick={() => setStep(issue.step)}
                    >
                      Fix step
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {finalized && (
            <div className="review-success" style={{ marginTop: "var(--space-3)" }}>
              <strong>Test created successfully.</strong>
            </div>
          )}

          {finalizationError && (
            <div className="form-error" style={{ marginTop: "var(--space-3)" }}>
              {finalizationError}
            </div>
          )}

          <div className="admin-toolbar" style={{ marginTop: "var(--space-3)", display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
            <button
              type="button"
              className="admin-button"
              disabled={saving || finalizing}
              onClick={async () => {
                if (!testId) {
                  setFinalizationError("Draft must be saved first.");
                  return;
                }
                setSaving(true);
                setFinalizationError("");
                const csrf = await getCsrfToken();
                const nextAudioMap = Object.fromEntries(selection.map((item) => [item.key, item.assetId]));
                const yaml = serializeConfig(
                  name.trim(),
                  testType,
                  nextAudioMap,
                  selection,
                  pages,
                  mosMin,
                  mosMax,
                  susQuota,
                  mosLabels,
                  calibrationAudioRef || null,
                  mosPrompt.trim(),
                  scaleId,
                  scaleName,
                  language
                );
                const patchResponse = await adminRequest(`/admin/api/tests/${testId}`, {
                  method: "PATCH",
                  headers: { "X-CSRF-Token": csrf },
                  body: JSON.stringify({ yaml }),
                });
                setSaving(false);
                if (!patchResponse.ok) {
                  const payload = (await patchResponse.json().catch(() => ({}))) as {
                    errors?: string[];
                    error?: string;
                  };
                  setFinalizationError(payload.errors?.join(" ") || payload.error || "Could not save draft.");
                  return;
                }
                setFinalized(true);
                window.location.href = "/admin/tests";
              }}
            >
              {saving ? "Saving…" : isPublished || wasPublished ? "Save test" : "Save draft"}
            </button>

            <button
              type="button"
              className="admin-button admin-button--primary"
              disabled={reviewDisabled || !testId || finalizing || saving}
              onClick={async () => {
                setFinalizationError("");
                if (!testId) {
                  setFinalizationError(
                    isPublished || wasPublished
                      ? "Test must be saved before publishing."
                      : "Draft must be saved before publishing."
                  );
                  return;
                }
                setFinalizing(true);
                const csrf = await getCsrfToken();
                const url = `/admin/api/tests/${testId}/publish`;
                const response = await adminRequest(url, {
                  method: "POST",
                  headers: { "X-CSRF-Token": csrf },
                });
                let payload: { errors?: string[]; error?: string; status?: string } | null = null;
                try {
                  payload = (await response.json()) as { errors?: string[]; error?: string; status?: string } | null;
                } catch {
                  payload = null;
                }
                setFinalizing(false);
                if (!response.ok) {
                  if (response.status === 404) {
                    setDraftMissing(true);
                  }
                  const message = payload?.errors?.length
                    ? payload.errors.join(" ")
                    : payload?.error
                    ? payload.error
                    : response.status === 404
                    ? `${isPublished || wasPublished ? "Test" : "Draft"} #${testId} not found. HTTP 404 NOT FOUND`
                    : `Could not ${isPublished || wasPublished ? "save" : "publish"} the test. HTTP ${response.status} ${response.statusText}`;
                  setFinalizationError(message);
                  return;
                }
                setFinalized(true);
                window.location.href = "/admin/tests";
              }}
            >
              {finalizing
                ? isPublished || wasPublished
                  ? "Saving…"
                  : "Publishing…"
                : isPublished || wasPublished
                ? "Save & publish test"
                : "Save and publish"}
            </button>
          </div>
        </div>
      )}

      {/* Navigation Toolbar */}
      <div className="admin-toolbar" style={{ marginTop: "var(--space-2)" }}>
        {step > 0 && (
          <button type="button" className="admin-button" onClick={() => setStep(step - 1)}>
            Previous
          </button>
        )}
        {step > 2 && step < steps.length - 1 && (
          <button
            type="button"
            className="admin-button admin-button--primary"
            onClick={() => setStep(step + 1)}
          >
            Next
          </button>
        )}
      </div>
    </section>
  );
}

export default function Page() {
  return (
    <Suspense
      fallback={
        <section className="admin-page">
          <p className="eyebrow">Studies</p>
          <h1>New test</h1>
          <p className="admin-lede">Loading…</p>
        </section>
      }
    >
      <NewTestWizard />
    </Suspense>
  );
}
