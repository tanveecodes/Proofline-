import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FAILURE_TYPES,
  Phase2Api,
  type BenchmarkReport,
  type CompareReport,
  type FailureType,
  type Phase2Annotation,
  type Phase2Dataset,
  type Phase2GenerationJob,
  type Phase2DatasetSummary,
  type Phase2Document,
} from "./api/phase2Adapter";

const FAILURE_LABELS: Record<FailureType, string> = {
  none: "No failure",
  retrieval_miss: "Relevant passage missing",
  wrong_chunk: "Wrong chunk retrieved",
  ignored_context: "Answer ignored useful context",
  unsupported_claim: "Unsupported answer claim",
  stale_source: "Stale or wrong source",
  incorrect_answer: "Incorrect answer",
};

function documentOptionLabel(document: Phase2Document): string {
  const uploaded = document.createdAt ? new Date(document.createdAt).toLocaleString() : "unknown upload date";
  return `${document.filename} · ${uploaded} · ${document.id.slice(0, 8)}`;
}

const EMPTY_TEMPLATE = {
  name: "Phase 2 human-labeled QA set",
  cases: [{ id: "case-001", question: "", referenceAnswer: "", expectedEvidence: "", expectedSource: "" }],
};

function scoreLabel(score: number | null | undefined): string {
  return score == null ? "—" : `${Math.round(score * 100)}%`;
}

function rateLabel(value: number | null | undefined): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

export default function PhaseTwoPanel({ baseUrl, activeDocumentId }: { baseUrl: string | null; activeDocumentId: string | null }) {
  const api = useMemo(() => baseUrl ? new Phase2Api(baseUrl) : null, [baseUrl]);
  const fileRef = useRef<HTMLInputElement>(null);
  const answersRef = useRef<HTMLInputElement>(null);
  const [datasets, setDatasets] = useState<Phase2DatasetSummary[]>([]);
  const [dataset, setDataset] = useState<Phase2Dataset | null>(null);
  const [documents, setDocuments] = useState<Phase2Document[]>([]);
  const [caseIndex, setCaseIndex] = useState(0);
  const [annotatorId, setAnnotatorId] = useState(() => {
    try { return localStorage.getItem("phase2-annotator-id") || "reviewer-1"; } catch { return "reviewer-1"; }
  });
  const [failureType, setFailureType] = useState<FailureType>("none");
  const [answerCorrect, setAnswerCorrect] = useState<"" | "yes" | "no">("");
  const [evidenceRelevant, setEvidenceRelevant] = useState<"" | "yes" | "no">("");
  const [benchmarkDocumentId, setBenchmarkDocumentId] = useState("");
  const [baselineDocumentId, setBaselineDocumentId] = useState("");
  const [candidateDocumentId, setCandidateDocumentId] = useState("");
  const [baselineTopK, setBaselineTopK] = useState(3);
  const [candidateTopK, setCandidateTopK] = useState(5);
  const [baselineMinScore, setBaselineMinScore] = useState(0.01);
  const [candidateMinScore, setCandidateMinScore] = useState(0.01);
  const [systemAnswers, setSystemAnswers] = useState<Array<{ caseId: string; answer: string }> | null>(null);
  const [generateCount, setGenerateCount] = useState(150);
  const [generationJob, setGenerationJob] = useState<Phase2GenerationJob | null>(null);
  const lastActiveDocumentId = useRef<string | null | undefined>(undefined);
  const [benchmarkReport, setBenchmarkReport] = useState<BenchmarkReport | null>(null);
  const [compareReport, setCompareReport] = useState<CompareReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Phase 2 is scoped to the document the user uploaded. Documents and datasets left behind by
  // earlier runs stay on the backend but are never offered as generation sources.
  const [lastDocumentId, setLastDocumentId] = useState<string | null>(() => {
    try { return localStorage.getItem("phase2-active-document"); } catch { return null; }
  });
  const scopedDocumentId = activeDocumentId ?? lastDocumentId;

  useEffect(() => {
    if (!activeDocumentId) return;
    setLastDocumentId(activeDocumentId);
    try { localStorage.setItem("phase2-active-document", activeDocumentId); } catch { /* The panel stays scoped for this session only. */ }
  }, [activeDocumentId]);

  const activeDocument = useMemo(
    () => documents.find((item) => item.id === scopedDocumentId) ?? null,
    [documents, scopedDocumentId],
  );

  const sourceDocuments = useMemo(() => {
    if (!activeDocument) return [];
    return documents.filter((item) => item.filename === activeDocument.filename);
  }, [documents, activeDocument]);

  const refreshSummaries = useCallback(async () => {
    if (!api) return;
    setDatasets(await api.listDatasets(scopedDocumentId ?? undefined));
  }, [api, scopedDocumentId]);

  const refreshDocuments = useCallback(async () => {
    if (!api) return;
    setDocuments(await api.listDocuments());
  }, [api]);

  useEffect(() => {
    if (!api) return;
    void refreshDocuments().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load Phase 2 data."));
  }, [api, refreshDocuments]);

  useEffect(() => {
    if (!api) return;
    setBenchmarkReport(null);
    setCompareReport(null);
    setSystemAnswers(null);
    setCaseIndex(0);
    if (!scopedDocumentId) {
      setDocuments([]);
      setDatasets([]);
      setDataset(null);
      setBenchmarkDocumentId("");
      setCandidateDocumentId("");
      setBaselineDocumentId("");
      lastActiveDocumentId.current = null;
      return;
    }
    setBenchmarkDocumentId(scopedDocumentId);
    setCandidateDocumentId(scopedDocumentId);
    setBaselineDocumentId(scopedDocumentId);
    let cancelled = false;
    void (async () => {
      try {
        const [nextDocuments, summaries] = await Promise.all([
          api.listDocuments(),
          api.listDatasets(scopedDocumentId),
        ]);
        if (cancelled) return;
        setDocuments(nextDocuments);
        setDatasets(summaries);
        const newest = [...summaries].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))[0];
        if (newest) {
          const selected = await api.getDataset(newest.id);
          if (cancelled) return;
          setDataset(selected);
          lastActiveDocumentId.current = scopedDocumentId;
          return;
        }
        setDataset(null);
        if (lastActiveDocumentId.current === scopedDocumentId) return;
        lastActiveDocumentId.current = scopedDocumentId;
        await generateDataset(scopedDocumentId, generateCount, true);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load this document's QA set.");
      }
    })();
    return () => { cancelled = true; };
  // Each upload re-scopes the panel to that document's own QA set; generation defaults to it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, scopedDocumentId]);

  useEffect(() => {
    if (!api || !generationJob || !["queued", "running"].includes(generationJob.status)) return;
    let cancelled = false;
    const poll = async () => {
      while (!cancelled) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        if (cancelled) return;
        try {
          const next = await api.getGenerationJob(generationJob.id);
          if (cancelled) return;
          if (["queued", "running"].includes(next.status)) setGenerationJob(next);
          if (["complete", "partial"].includes(next.status) && next.datasetId) {
            const generated = await api.getDataset(next.datasetId);
            if (cancelled) return;
            setGenerationJob(next);
            setDataset(generated);
            setCaseIndex(0);
            setSystemAnswers(null);
            setBenchmarkReport(null);
            setCompareReport(null);
            await refreshSummaries();
            setNotice(`Llama generated ${generated.cases.length} of ${next.requestedCount} requested source-verified pairs. These are AI-generated candidates and still need two human reviewers each.`);
            return;
          }
          if (next.status === "failed") {
            setGenerationJob(next);
            setError(next.error || "Local Llama generation failed.");
            return;
          }
        } catch (reason) {
          if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not check Llama generation progress.");
        }
      }
    };
    void poll();
    return () => { cancelled = true; };
  }, [api, generationJob?.id, generationJob?.status, refreshSummaries]);

  const currentCase = dataset?.cases[caseIndex] ?? null;
  useEffect(() => {
    const saved = currentCase?.annotations.find((annotation) => annotation.annotatorId === annotatorId);
    setFailureType(saved?.failureType ?? "none");
    setAnswerCorrect(saved ? (saved.answerCorrect ? "yes" : "no") : "");
    setEvidenceRelevant(saved ? (saved.evidenceRelevant ? "yes" : "no") : "");
  }, [currentCase?.id, currentCase?.annotations, annotatorId]);

  const chooseDataset = async (id: string) => {
    if (!api || !id) { setDataset(null); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const selected = await api.getDataset(id);
      setDataset(selected);
      setCaseIndex(0);
      setBenchmarkReport(null);
      setCompareReport(null);
      setSystemAnswers(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not open that dataset."); }
    finally { setBusy(false); }
  };

  const importDataset = async (file: File | undefined) => {
    if (!api || !file) return;
    if (file.size > 2 * 1024 * 1024) { setError("Dataset JSON must be 2 MB or smaller."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const payload = JSON.parse(await file.text()) as Record<string, unknown>;
      const created = await api.createDataset({ ...payload, documentId: scopedDocumentId ?? undefined });
      const selected = await api.getDataset(created.id);
      setDataset(selected);
      setCaseIndex(0);
      setBenchmarkReport(null);
      setCompareReport(null);
      setSystemAnswers(null);
      await refreshSummaries();
      setNotice(`Imported ${selected.cases.length} QA pair${selected.cases.length === 1 ? "" : "s"}. They are not counted as human-labeled until two reviewers label each pair.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not import the dataset. Check the JSON format."); }
    finally { setBusy(false); }
  };

  const generateDataset = async (documentId = benchmarkDocumentId, count = generateCount, automatic = false) => {
    if (!api || !documentId) return;
    setGenerationJob(null); setError(""); setNotice("");
    try {
      const job = await api.generateDataset(documentId, count);
      setGenerationJob(job);
      setBenchmarkDocumentId(documentId);
      if (automatic) setNotice(`Llama is generating up to ${count} questions from the uploaded PDF in the background. You can continue using the page.`);
      else setNotice(`Started local Llama generation for ${count} questions. This runs in the background.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not start Llama question generation."); }
  };

  const saveCurrentAnnotation = async () => {
    if (!api || !dataset || !currentCase || answerCorrect === "" || evidenceRelevant === "") return;
    const annotation: Omit<Phase2Annotation, "updatedAt"> = {
      annotatorId: annotatorId.trim(),
      failureType,
      answerCorrect: answerCorrect === "yes",
      evidenceRelevant: evidenceRelevant === "yes",
    };
    setBusy(true); setError(""); setNotice("");
    try {
      const updated = await api.saveAnnotation(dataset.id, currentCase.id, annotation);
      setDataset(updated);
      await refreshSummaries();
      setNotice(`Saved ${annotatorId.trim()}'s label for pair ${caseIndex + 1}.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save this label."); }
    finally { setBusy(false); }
  };

  const runBenchmark = async () => {
    if (!api || !dataset || !benchmarkDocumentId) return;
    setBusy(true); setError(""); setNotice("");
    try { setBenchmarkReport(await api.runBenchmark(benchmarkDocumentId, dataset.id, systemAnswers || undefined)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not run the benchmark."); }
    finally { setBusy(false); }
  };

  const importSystemAnswers = async (file: File | undefined) => {
    if (!file || !dataset) return;
    setError(""); setNotice("");
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error("System answer JSON must be 2 MB or smaller.");
      const payload = JSON.parse(await file.text()) as { answers?: unknown };
      if (!Array.isArray(payload?.answers)) throw new Error("Expected JSON with an answers array of { caseId, answer } rows.");
      const rows = payload.answers as Array<{ caseId?: unknown; answer?: unknown }>;
      if (rows.length !== dataset.cases.length || rows.some((row) => typeof row?.caseId !== "string" || typeof row.answer !== "string" || !row.answer.trim())) {
        throw new Error(`Provide exactly ${dataset.cases.length} non-empty answers, each matched to a caseId.`);
      }
      const expectedIds = new Set(dataset.cases.map((item) => item.id));
      const seenIds = new Set<string>();
      for (const row of rows) {
        if (!expectedIds.has(row.caseId as string) || seenIds.has(row.caseId as string)) throw new Error("Every caseId must match one dataset pair exactly once.");
        seenIds.add(row.caseId as string);
      }
      setSystemAnswers(rows.map((row) => ({ caseId: row.caseId as string, answer: (row.answer as string).trim() })));
      setBenchmarkReport(null);
      setNotice(`Loaded ${rows.length} system answers. They will be matched by case ID and scored without a judge-model call.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not import system answers."); }
  };

  const compareVersions = async () => {
    if (!api || !dataset || !baselineDocumentId || !candidateDocumentId) return;
    setBusy(true); setError(""); setNotice("");
    try {
      setCompareReport(await api.compare({
        baselineDocumentId, candidateDocumentId, datasetId: dataset.id,
        baselineConfig: { topK: baselineTopK, minScore: baselineMinScore },
        candidateConfig: { topK: candidateTopK, minScore: candidateMinScore },
      }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not compare these versions."); }
    finally { setBusy(false); }
  };

  const downloadTemplate = () => {
    const blob = new Blob([JSON.stringify(EMPTY_TEMPLATE, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download = "phase2-qa-dataset-template.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  const downloadSystemAnswersTemplate = () => {
    if (!dataset) return;
    const blob = new Blob([JSON.stringify({ answers: dataset.cases.map((item) => ({ caseId: item.id, answer: "" })) }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download = "rag-system-answers-template.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  const canCompare = Boolean(dataset && baselineDocumentId && candidateDocumentId && (
    baselineDocumentId !== candidateDocumentId || baselineTopK !== candidateTopK || baselineMinScore !== candidateMinScore
  ));

  return <section className="phase2-area" id="phase2">
    <div className="phase2-title-row"><div><div className="panel-kicker">PHASE 2 · EXTENDED EVALUATION</div><h2>Make the evaluator itself accountable</h2><p>Double-label examples, measure agreement, diagnose failure categories, and compare versions on the same cases.</p></div><span className="phase2-badge">MODEL-INDEPENDENT BENCHMARK</span></div>
    {!api && <div className="phase2-callout">Phase 2 requires the local backend. Set <code>VITE_API_BASE_URL</code> and restart Vite to use annotation, benchmark, and comparison tools.</div>}
    {error && <div className="error-notice" role="alert"><strong>Phase 2 request failed</strong><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}
    {notice && <div className="phase2-success" role="status">{notice}</div>}

    <div className="phase2-grid">
      <article className="panel phase2-card dataset-card">
        <div className="panel-kicker">01 · DOUBLE-LABELED QA SET</div><h3>Build the human reference set</h3>
        <p>The four known-answer prompts in the main workbench are curated demos. A newly uploaded document starts local Llama generation automatically, requesting up to 150 source-grounded candidates; these do not count as human labels until two reviewers label each one.</p>
        <div className="phase2-label">SOURCE DOCUMENT FOR GENERATION</div><div className="phase2-source">{activeDocument ? documentOptionLabel(activeDocument) : "Upload a document in the Knowledge base first"}</div>
        <div className="phase2-actions"><label className="phase2-label" htmlFor="generate-count">GENERATE QUESTION COUNT</label><select id="generate-count" className="flow-select" value={generateCount} disabled={busy} onChange={(event) => setGenerateCount(Number(event.target.value))}><option value={110}>110 pairs</option><option value={150}>150 pairs</option><option value={200}>200 pairs</option></select><button type="button" className="button button-primary" disabled={!api || !benchmarkDocumentId || busy || Boolean(generationJob && ["queued", "running"].includes(generationJob.status))} onClick={() => void generateDataset()}>{generationJob && ["queued", "running"].includes(generationJob.status) ? "Llama is generating…" : `Generate ${generateCount} QA pairs with Llama`}</button></div>
        {generationJob && <div className="phase2-progress-row" role="status"><span>{generationJob.status === "failed" ? `Generation failed: ${generationJob.error || "unknown error"}` : `${generationJob.status === "queued" ? "Waiting for local Llama" : "Llama generating"} · ${generationJob.generatedCount}/${generationJob.requestedCount} verified questions · batch ${generationJob.completedBatches}/${generationJob.totalBatches || "…"}`}</span><strong>{generationJob.progress}%</strong></div>}
        {generationJob && <div className="phase2-progress"><i style={{ width: `${generationJob.progress}%` }} /></div>}
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(event) => { void importDataset(event.target.files?.[0]); event.currentTarget.value = ""; }} />
        <div className="phase2-actions"><button type="button" className="button button-primary" disabled={!api || busy} onClick={() => fileRef.current?.click()}>↑ Import QA JSON</button><button type="button" className="button button-outline" onClick={downloadTemplate}>Download template</button></div>
        <label className="phase2-label" htmlFor="dataset-choice">ACTIVE DATASET</label>
        <select id="dataset-choice" className="flow-select" value={dataset?.id ?? ""} disabled={!api || busy || datasets.length === 0} onChange={(event) => void chooseDataset(event.target.value)}><option value="">{datasets.length ? "Choose a dataset" : activeDocument ? "No QA set for this document yet" : "Upload a document first"}</option>{datasets.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.doubleLabeled}/{item.totalCases} double-labeled</option>)}</select>
        {dataset && <><div className="phase2-progress-row"><span>{dataset.fullAgreementCount} / 150 pairs fully agreed by both reviewers</span><strong>{dataset.target150Progress}%</strong></div><div className="phase2-progress"><i style={{ width: `${dataset.target150Progress}%` }} /></div><div className="phase2-stat-grid"><div><b>{dataset.totalCases}</b><small>Imported pairs</small></div><div><b>{dataset.doubleLabeled}</b><small>Two reviewers</small></div><div><b>{dataset.fullAgreementCount}</b><small>Full label agreement</small></div><div><b>{rateLabel(dataset.failureTypeAgreement)}</b><small>Failure-type agreement</small></div><div><b>{dataset.failureTypeCohenKappa == null ? "—" : dataset.failureTypeCohenKappa.toFixed(2)}</b><small>Cohen’s κ</small></div><div><b>{rateLabel(dataset.answerCorrectnessAgreement)}</b><small>Answer agreement</small></div><div><b>{rateLabel(dataset.evidenceRelevanceAgreement)}</b><small>Evidence agreement</small></div></div></>}
      </article>

      <article className="panel phase2-card annotation-card">
        <div className="panel-kicker">02 · HUMAN REVIEW</div><h3>Label the selected pair</h3>
        {!dataset || !currentCase ? <div className="empty-state">Import or choose a QA set to begin two-person review.</div> : <>
          <div className="case-navigation"><button type="button" className="button button-quiet" disabled={caseIndex === 0 || busy} onClick={() => setCaseIndex((value) => Math.max(0, value - 1))}>← Previous</button><span>PAIR {caseIndex + 1} / {dataset.cases.length}</span><button type="button" className="button button-quiet" disabled={caseIndex >= dataset.cases.length - 1 || busy} onClick={() => setCaseIndex((value) => Math.min(dataset.cases.length - 1, value + 1))}>Next →</button></div>
          <div className="annotation-question"><small>QUESTION</small><p>{currentCase.question}</p><small>REFERENCE ANSWER</small><p>{currentCase.referenceAnswer}</p>{currentCase.expectedEvidence && <><small>EXPECTED EVIDENCE</small><p>{currentCase.expectedEvidence}</p></>}{currentCase.expectedSource && <><small>EXPECTED SOURCE{currentCase.expectedPage == null ? "" : ` · PAGE ${currentCase.expectedPage}`}</small><p>{currentCase.expectedSource}</p></>}</div>
          <label className="phase2-label" htmlFor="reviewer-id">REVIEWER ID</label><input id="reviewer-id" className="flow-input" value={annotatorId} maxLength={80} onChange={(event) => { setAnnotatorId(event.target.value); try { localStorage.setItem("phase2-annotator-id", event.target.value); } catch { /* Reviewer ID remains available for this session. */ } }} placeholder="Use a distinct ID for each reviewer" />
          <label className="phase2-label" htmlFor="failure-label">FAILURE TYPE</label><select id="failure-label" className="flow-select" value={failureType} onChange={(event) => setFailureType(event.target.value as FailureType)}>{FAILURE_TYPES.map((type) => <option key={type} value={type}>{FAILURE_LABELS[type]}</option>)}</select>
          <div className="annotation-binary"><label>Is the answer correct?<select className="flow-select" value={answerCorrect} onChange={(event) => setAnswerCorrect(event.target.value as "" | "yes" | "no")}><option value="">Choose…</option><option value="yes">Yes</option><option value="no">No</option></select></label><label>Is the retrieved evidence relevant?<select className="flow-select" value={evidenceRelevant} onChange={(event) => setEvidenceRelevant(event.target.value as "" | "yes" | "no")}><option value="">Choose…</option><option value="yes">Yes</option><option value="no">No</option></select></label></div>
          <div className="annotation-existing"><b>Saved labels</b>{currentCase.annotations.length ? currentCase.annotations.map((entry) => <span key={entry.annotatorId}>{entry.annotatorId}: {FAILURE_LABELS[entry.failureType]}</span>) : <span>No reviewer labels yet</span>}</div>
          <button type="button" className="button button-primary save-label" disabled={busy || !annotatorId.trim() || answerCorrect === "" || evidenceRelevant === ""} onClick={() => void saveCurrentAnnotation()}>{busy ? "Saving…" : "Save reviewer label"}</button>
        </>}
      </article>
    </div>

    <div className="phase2-grid analysis-grid">
      <article className="panel phase2-card">
        <div className="panel-kicker">03 · CONFUSION MATRIX & THROUGHPUT</div><h3>Benchmark evaluator predictions</h3>
        <p>Import actual outputs from your RAG system for answer evaluation, or run the extractive baseline. Evidence retrieval is query-only; answer scores use deterministic lexical checks and no judge-model call. The JSON format has one case ID and answer row per question.</p>
        <div className="analysis-controls"><label className="phase2-label" htmlFor="benchmark-doc">DOCUMENT VERSION</label><select id="benchmark-doc" className="flow-select" value={benchmarkDocumentId} disabled={sourceDocuments.length === 0} onChange={(event) => setBenchmarkDocumentId(event.target.value)}><option value="">{sourceDocuments.length ? "Choose a document" : "Upload a document first"}</option>{sourceDocuments.map((item) => <option key={item.id} value={item.id}>{documentOptionLabel(item)}</option>)}</select><input ref={answersRef} type="file" accept=".json,application/json" hidden onChange={(event) => { void importSystemAnswers(event.target.files?.[0]); event.currentTarget.value = ""; }} /><button type="button" className="button button-outline" disabled={!dataset || busy} onClick={() => answersRef.current?.click()}>{systemAnswers ? `✓ ${systemAnswers.length} system answers loaded` : "Import system answers JSON"}</button><button type="button" className="button button-quiet" disabled={!dataset || busy} onClick={downloadSystemAnswersTemplate}>Download answer template</button>{systemAnswers && <button type="button" className="button button-quiet" disabled={busy} onClick={() => { setSystemAnswers(null); setBenchmarkReport(null); }}>Use extractive baseline</button>}<button type="button" className="button button-primary" disabled={!api || !dataset || !benchmarkDocumentId || busy} onClick={() => void runBenchmark()}>{busy ? "Running benchmark…" : `Evaluate ${dataset?.totalCases ?? 0} questions`}</button></div>
        {benchmarkReport && <div className="benchmark-results"><div className="phase2-stat-grid"><div><b>{rateLabel(benchmarkReport.confusion.pipelineAgreement)}</b><small>Pipeline vs consensus ({benchmarkReport.confusion.comparedPairs} pairs)</small></div><div><b>{rateLabel(benchmarkReport.annotationMetrics.failureTypeAgreement)}</b><small>Rater agreement</small></div><div><b>{benchmarkReport.performance.questionCount}/200</b><small>Question target</small></div><div><b>{benchmarkReport.performance.questionsPerMinute}</b><small>Questions / minute</small></div><div><b>{(benchmarkReport.performance.durationMs / 1000).toFixed(2)}s</b><small>{benchmarkReport.performance.meets200QuestionTarget ? "Meets 200 in 15m" : benchmarkReport.performance.under15Minutes ? "This run <15m; 200 target unmeasured" : "Run exceeded 15 minutes"}</small></div></div><p className="scoring-note">Excluded from confusion matrix: {benchmarkReport.confusion.excludedPairs.unreviewed} not double-reviewed, {benchmarkReport.confusion.excludedPairs.reviewerDisagreement} reviewer disagreements, {benchmarkReport.confusion.excludedPairs.invalidPrediction} invalid rows, {benchmarkReport.confusion.excludedPairs.duplicateResult} duplicate results. Only two-reviewer consensus cases are compared.</p><div className="matrix-heading"><strong>Confusion matrix</strong><span>Rows = human consensus · columns = pipeline</span></div><div className="matrix-scroll"><table className="confusion-table"><thead><tr><th>Human ↓ / Pipeline →</th>{benchmarkReport.confusion.labels.map((label) => <th key={label}>{FAILURE_LABELS[label]}</th>)}</tr></thead><tbody>{benchmarkReport.confusion.labels.map((gold) => <tr key={gold}><th>{FAILURE_LABELS[gold]}</th>{benchmarkReport.confusion.labels.map((predicted) => <td className={gold === predicted && benchmarkReport.confusion.matrix[gold][predicted] ? "matrix-match" : ""} key={predicted}>{benchmarkReport.confusion.matrix[gold][predicted]}</td>)}</tr>)}</tbody></table></div><div className="diagnostic-list"><div className="matrix-heading"><strong>Per-question diagnoses</strong><span>{benchmarkReport.evaluationMode === "external_answers" ? "Imported system outputs" : "Extractive baseline outputs"}</span></div>{benchmarkReport.results.filter((item) => item.predictedFailure !== "none").slice(0, 12).map((item) => <article className="diagnostic-item" key={item.caseId}><strong>{FAILURE_LABELS[item.predictedFailure as FailureType] || "Unclassified"} · {item.question}</strong><p>{item.diagnosis}</p><small>Answer: {item.answer}</small>{item.retrievedEvidence.slice(0, 2).map((evidence, index) => <small key={`${item.caseId}-${index}`}>Evidence · {evidence.source}{evidence.page == null ? "" : ` · p.${evidence.page}`}: {evidence.text.slice(0, 280)}{evidence.text.length > 280 ? "…" : ""}</small>)}</article>)}{benchmarkReport.results.every((item) => item.predictedFailure === "none") && <p className="scoring-note">No failure signals crossed the heuristic thresholds in this run.</p>}</div><p className="scoring-note">{benchmarkReport.scoringNote}</p></div>}
      </article>

      <article className="panel phase2-card">
        <div className="panel-kicker">04 · REGRESSION CHECK</div><h3>Compare two RAG versions</h3>
        <p>Run the same QA cases against two recorded RAG configurations. You can compare source document versions, retrieval settings, or both. Regressions flag a score drop of 10 points or more, or a supported-to-failed status change.</p>
        <div className="compare-fields"><label><span>BASELINE DOCUMENT</span><select className="flow-select" value={baselineDocumentId} disabled={sourceDocuments.length === 0} onChange={(event) => setBaselineDocumentId(event.target.value)}><option value="">{sourceDocuments.length ? "Choose baseline" : "Upload a document first"}</option>{sourceDocuments.map((item) => <option key={item.id} value={item.id}>{documentOptionLabel(item)}</option>)}</select></label><label><span>CANDIDATE DOCUMENT</span><select className="flow-select" value={candidateDocumentId} disabled={sourceDocuments.length === 0} onChange={(event) => setCandidateDocumentId(event.target.value)}><option value="">{sourceDocuments.length ? "Choose candidate" : "Upload a document first"}</option>{sourceDocuments.map((item) => <option key={item.id} value={item.id}>{documentOptionLabel(item)}</option>)}</select></label><label><span>BASELINE TOP K ({baselineTopK})</span><input type="range" min="1" max="10" value={baselineTopK} onChange={(event) => setBaselineTopK(Number(event.target.value))} /></label><label><span>CANDIDATE TOP K ({candidateTopK})</span><input type="range" min="1" max="10" value={candidateTopK} onChange={(event) => setCandidateTopK(Number(event.target.value))} /></label><label><span>BASELINE MIN SCORE ({baselineMinScore.toFixed(2)})</span><input type="range" min="0" max="0.5" step="0.01" value={baselineMinScore} onChange={(event) => setBaselineMinScore(Number(event.target.value))} /></label><label><span>CANDIDATE MIN SCORE ({candidateMinScore.toFixed(2)})</span><input type="range" min="0" max="0.5" step="0.01" value={candidateMinScore} onChange={(event) => setCandidateMinScore(Number(event.target.value))} /></label></div>
        <button type="button" className="button button-primary compare-button" disabled={!api || !dataset || !canCompare || busy} onClick={() => void compareVersions()}>{busy ? "Comparing versions…" : "Compare on the same cases"}</button>
        {!canCompare && sourceDocuments.length === 0 && <small className="comparison-hint">Upload a document first. You can compare two retrieval configurations on that same document or compare two versions of it.</small>}
        {compareReport && <div className="comparison-results"><div className="version-averages"><VersionAverage version={compareReport.baseline}/><span className="version-divider">→</span><VersionAverage version={compareReport.candidate}/></div><div className={`regression-summary ${compareReport.regressionCount ? "has-regressions" : "clean"}`}>{compareReport.regressionCount} regression{compareReport.regressionCount === 1 ? "" : "s"} across {compareReport.questionCount} matched cases</div>{compareReport.regressions.length > 0 && <ul className="regression-list">{compareReport.regressions.slice(0, 8).map((item) => <li key={item.caseId}><strong>{item.question}</strong><span>{item.signals.join(" · ")}</span></li>)}</ul>}<p className="scoring-note">Throughput: {compareReport.performance.questionCount}/200 cases in {(compareReport.performance.durationMs / 1000).toFixed(2)}s · {compareReport.performance.meets200QuestionTarget ? "meets the target" : compareReport.performance.under15Minutes ? "under 15 minutes for this run; the 200-case target is not yet measured" : "over the 15-minute target"}</p><p className="scoring-note">{compareReport.scoringNote}</p></div>}
      </article>
    </div>
    <div className="phase2-footnote">Failure labels: {FAILURE_TYPES.filter((type) => type !== "none").map((type) => FAILURE_LABELS[type]).join(" · ")}. The app provides the labeling and measurement workflow; the team must supply and annotate its own 150+ QA pairs.</div>
  </section>;
}

function VersionAverage({ version }: { version: CompareReport["baseline"] }) {
  return <div className="version-average"><strong>{version.label}</strong><span>topK {version.config.topK} · min score {version.config.minScore.toFixed(2)}</span><span>Retrieval {scoreLabel(version.averageScores.retrieval)} · Support {scoreLabel(version.averageScores.support)} · Correctness {scoreLabel(version.averageScores.correctness)}</span></div>;
}
