import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import type { CSSProperties } from "react";
import { createApi, readApiConfig, type RagEvalApi } from "./api/adapter";
import { SAMPLE_DOCUMENT } from "./api/sampleData";
import PhaseTwoPanel from "./PhaseTwoPanel";
import type {
  DocumentRef,
  EvalResult,
  Evaluation,
  EvaluationOutcome,
  ProcessingStatus,
  SampleQuestion,
} from "./types";

function stageLabel(stage: ProcessingStatus["stage"]): string {
  const labels: Record<ProcessingStatus["stage"], string> = {
    queued: "QUEUED", uploading: "UPLOADING", parsing: "PARSING", chunking: "CHUNKING",
    indexing: "INDEXING", ready: "READY", failed: "FAILED",
  };
  return labels[stage];
}

function verdictCopy(result: EvalResult): { label: string; state: string; sub: string } {
  switch (result.verdict) {
    case "supported": return { label: "SUPPORTED ANSWER", state: "good", sub: "Evidence and answer agree" };
    case "unsupported": return { label: "UNSUPPORTED ANSWER", state: "bad", sub: "Answer has claims without evidence" };
    case "incorrect": return { label: "CONTRADICTS SOURCE", state: "bad", sub: "Relevant context was retrieved" };
    default: return { label: "NOT EVALUATED", state: "unknown", sub: "Sample question has no known result" };
  }
}

function outcomeCopy(evaluation: Evaluation): { label: string; state: string } {
  const states: Record<EvaluationOutcome, { label: string; state: string }> = {
    pass: { label: "PASS", state: "good" },
    fail: { label: "FAIL", state: "bad" },
    partial: { label: "PARTIAL", state: "warn" },
    unknown: { label: "N / A", state: "unknown" },
  };
  return states[evaluation.outcome];
}

function percent(score: number | null | undefined): string | null {
  return score == null ? null : `${Math.round(score * 100)}%`;
}

function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [api, setApi] = useState<RagEvalApi | null>(null);
  const [apiMode, setApiMode] = useState<"sample" | "http">("sample");
  const [apiBaseUrl, setApiBaseUrl] = useState<string | null>(null);
  const [document, setDocument] = useState<DocumentRef | null>(null);
  const [processing, setProcessing] = useState<ProcessingStatus | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [questions, setQuestions] = useState<SampleQuestion[]>([]);
  const [questionsReady, setQuestionsReady] = useState(false);
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<EvalResult | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    try {
      const savedTheme = localStorage.getItem("proofline-theme");
      if (savedTheme === "light") window.document.body.dataset.theme = "light";
      else if (savedTheme === "dark") window.document.body.removeAttribute("data-theme");
    } catch { /* Keep the default dark theme when browser storage is unavailable. */ }
    const config = readApiConfig();
    setApiMode(config.mode);
    setApiBaseUrl(config.mode === "http" ? config.baseUrl ?? null : null);
    createApi().then(async (createdApi) => {
      setApi(createdApi);
      if (config.mode === "sample") {
        setDocument(SAMPLE_DOCUMENT);
        setProcessing({ stage: "ready", progress: 1, message: "Sample document ready" });
        const samples = await createdApi.listSampleQuestions(SAMPLE_DOCUMENT.id);
        setQuestions(samples);
        setQuestionsReady(true);
      }
    }).catch(() => setError("The evaluation adapter could not be initialized."));
  }, []);

  const loadQuestions = useCallback(async (documentId: string) => {
    if (!api) return;
    setQuestionsReady(false);
    try {
      const nextQuestions = await api.listSampleQuestions(documentId);
      setQuestions(nextQuestions);
      setQuestionsReady(true);
    } catch {
      setQuestions([]);
      setQuestionsReady(true);
      setError("Could not load this document's known-answer questions.");
    }
  }, [api]);

  const uploadFile = useCallback(async (file: File) => {
    if (!api) return;
    const supported = /\.(pdf|txt|md|docx)$/i.test(file.name);
    if (!supported) {
      setError("Choose a PDF, TXT, Markdown, or DOCX file.");
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setError("This file is over the 15 MB limit.");
      return;
    }
    setError("");
    setResult(null);
    setWorking(true);
    setUploadProgress(0);
    setProcessing({ stage: "uploading", progress: 0, message: "Starting upload" });
    try {
      const uploaded = await api.uploadDocument(file, (fraction) => {
        setUploadProgress(fraction);
        if (fraction >= 1) {
          setProcessing((current) => current ? { ...current, stage: "parsing", progress: 0.5, message: "Upload complete; extracting text and building the search index" } : current);
        }
      });
      setDocument(uploaded);
      let current: ProcessingStatus = { stage: "queued", progress: 0, message: "Waiting to process" };
      for (let attempt = 0; attempt < 20; attempt += 1) {
        current = await api.getProcessingStatus(uploaded.id);
        setProcessing(current);
        if (current.stage === "ready" || current.stage === "failed") break;
        await new Promise((resolve) => window.setTimeout(resolve, 450));
      }
      if (current.stage === "failed") throw new Error(current.message || "Document processing failed.");
      if (current.stage !== "ready") throw new Error("Document processing took too long. Try again.");
      await loadQuestions(uploaded.id);
    } catch (uploadError) {
      const message = uploadError instanceof Error ? uploadError.message : "Document upload failed.";
      setError(message);
      setProcessing((current) => current ? { ...current, stage: "failed", message } : null);
    } finally {
      setWorking(false);
    }
  }, [api, loadQuestions]);

  const runQuestion = useCallback(async (value = question) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError("Enter a question or choose a sample test question.");
      return;
    }
    if (!api || !document || processing?.stage !== "ready") {
      setError("Upload and finish processing a document before evaluating a question.");
      return;
    }
    setQuestion(trimmed);
    setError("");
    setWorking(true);
    try {
      const nextResult = await api.evaluate({ documentId: document.id, question: trimmed });
      setResult(nextResult);
    } catch (evaluationError) {
      const message = evaluationError instanceof Error ? evaluationError.message : "Evaluation failed.";
      setError(message);
    } finally {
      setWorking(false);
    }
  }, [api, document, processing?.stage, question]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void runQuestion();
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void uploadFile(file);
  };

  const activeProcessing = processing && processing.stage !== "ready" && processing.stage !== "failed";
  const verdict = result ? verdictCopy(result) : null;
  const metric = (evaluation?: Evaluation) => percent(evaluation?.score) ?? "—";
  const metricStyle = (evaluation?: Evaluation) => evaluation?.score == null ? {} : { "--metric": `${evaluation.score * 100}%` } as CSSProperties;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#overview"><span className="brand-mark"><span>P</span></span><span>proofline</span></a>
        <div className="workspace-label">WORKSPACE</div>
        <div className="workspace-switch"><span className="workspace-avatar">AI</span><span>AI-04 · RAG Eval</span><span className="switch-caret">⌄</span></div>
        <div className="workspace-label nav-label">PIPELINE</div>
        <nav className="nav-group" aria-label="Dashboard sections">
          <a className="nav-item active" href="#overview"><span className="nav-icon">◫</span>Overview</a>
          <a className="nav-item" href="#documents"><span className="nav-icon">▤</span>Knowledge base{document && <span className="nav-count">01</span>}</a>
          <a className="nav-item" href="#tests"><span className="nav-icon">⌘</span>Test cases{questions.length > 0 && <span className="nav-count">{String(questions.length).padStart(2,"0")}</span>}</a>
          <a className="nav-item" href="#phase2"><span className="nav-icon">Ⅱ</span>Phase 2</a>
        </nav>
        <div className="sidebar-bottom"><span className={`online-dot ${processing?.stage === "ready" ? "" : "offline"}`} /><span>{processing?.stage === "ready" ? "Pipeline ready" : "Waiting for source"}</span><span className="version">{apiMode === "sample" ? "DEMO" : "LOCAL"}</span></div>
      </aside>

      <main className="main-content" id="overview">
        <header className="topbar">
          <div className="breadcrumbs"><span>AI-04</span><span className="crumb-sep">/</span><strong>Evaluation workbench</strong></div>
          <div className="topbar-actions"><span className={`status-pill ${working ? "warn" : processing?.stage === "ready" ? "pass" : "warn"}`} role="status" aria-live="polite"><i className={`online-dot ${working ? "working-dot" : ""}`} />{working ? (processing?.stage === "ready" ? "Evaluation running" : "Processing document") : processing?.stage === "ready" ? "Pipeline ready" : "Awaiting document"}</span><button className="theme-toggle" type="button" onClick={() => { const next = window.document.body.dataset.theme === "light" ? "dark" : "light"; if (next === "dark") window.document.body.removeAttribute("data-theme"); else window.document.body.dataset.theme = "light"; localStorage.setItem("proofline-theme", next); }} title="Toggle theme"><span>◐</span><span className="theme-label">Appearance</span></button><div className="avatar">AI</div></div>
        </header>

        <div className="page-content">
          <section className="page-heading">
            <div><div className="eyebrow">RAG EVALUATION WORKSPACE</div><h1>proofline</h1><p>Upload a source, ask a question, then inspect the answer, evidence, and each evaluation result.</p></div>
            <button className="button button-primary" type="button" onClick={() => void runQuestion()} disabled={working || processing?.stage !== "ready"}><span className={working ? "spinner" : ""}>{working ? "◌" : "▶"}</span>{working ? (processing?.stage === "ready" ? "Evaluating…" : "Processing…") : "Run evaluation"}</button>
          </section>

          {apiMode === "sample" && <div className="notice"><span>ⓘ</span><div><strong>Sample mode</strong><p>Results use the local demo adapter. Uploads are simulated in this mode.</p></div></div>}
          {error && <div className="error-notice" role="alert"><strong>Could not complete that step</strong><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss">×</button></div>}

          <section className="metric-row" aria-label="Evaluation summary">
            <article className="metric-card"><div className="metric-label">KNOWN TEST CASES <span className="metric-symbol">⌘</span></div><div className="metric-value">{questions.length ? String(questions.length).padStart(2,"0") : "—"}</div><div className="metric-foot"><span className="muted">From the active document</span></div></article>
            <article className="metric-card"><div className="metric-label">RETRIEVAL RELEVANCE <span className="metric-symbol">◎</span></div><div className="metric-value" style={metricStyle(result?.evaluations.retrieval)}>{metric(result?.evaluations.retrieval)}<small>{result?.evaluations.retrieval.score == null ? "" : " / 100"}</small></div><div className="metric-foot"><span className="muted">Relevant passages retrieved</span></div></article>
            <article className="metric-card"><div className="metric-label">ANSWER SUPPORT <span className="metric-symbol">✳</span></div><div className="metric-value" style={metricStyle(result?.evaluations.support)}>{metric(result?.evaluations.support)}<small>{result?.evaluations.support.score == null ? "" : " / 100"}</small></div><div className="metric-foot"><span className="muted">Grounded in retrieved text</span></div></article>
            <article className="metric-card"><div className="metric-label">ANSWER CORRECTNESS <span className="metric-symbol">✓</span></div><div className="metric-value" style={metricStyle(result?.evaluations.correctness)}>{metric(result?.evaluations.correctness)}<small>{result?.evaluations.correctness.score == null ? "" : " / 100"}</small></div><div className="metric-foot"><span className="muted">Compared with known answer</span></div></article>
          </section>

          <section className="panel docs-panel" id="documents">
            <div className="panel-header docs-header"><div><div className="panel-kicker">STEP 1 · SOURCE MATERIAL</div><h2>Knowledge base</h2><p>Upload one source document to retrieve passages and evaluate answers.</p></div><button type="button" className="button button-outline" onClick={() => inputRef.current?.click()} disabled={working}>↑ Upload document</button></div>
            <input ref={inputRef} type="file" accept=".pdf,.txt,.md,.docx,application/pdf,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadFile(file); event.currentTarget.value = ""; }} />
            <div className={`drop-zone ${dragging ? "dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={handleDrop} onClick={() => inputRef.current?.click()} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") inputRef.current?.click(); }}><div className="upload-icon">↑</div><div><strong>{document?.filename ?? "Drop a document here or browse"}</strong><span>PDF, DOCX, TXT, Markdown · up to 15 MB · {activeProcessing ? processing.message : processing?.stage === "ready" ? "Processed and ready" : "One active source at a time"}</span></div><button type="button" className="inline-link" onClick={(event) => { event.stopPropagation(); inputRef.current?.click(); }}>{document ? "Replace source" : "Browse files"}</button></div>
            {activeProcessing && <div className="upload-progress"><span>{stageLabel(processing.stage)} · {processing.message}</span><div className="progress-track"><i style={{ width: `${Math.max(uploadProgress, processing.progress) * 100}%` }} /></div></div>}
            {document && <div className="document-list"><div className="document-chip"><span className="document-icon">▤</span><span><strong>{document.filename}</strong><small>{processing?.stage === "ready" ? "Indexed and ready" : processing?.message}</small></span><span className="document-status">{processing?.stage === "ready" ? "READY" : stageLabel(processing?.stage ?? "queued")}</span></div></div>}
          </section>

          <section className="panel flow-panel" aria-labelledby="question-title">
            <div className="panel-header flow-header"><div><div className="panel-kicker">STEP 2 · ASK A QUESTION</div><h2 id="question-title">Run a question against your source</h2><p>End-to-end evaluation: retrieval, generated answer, support, and known-answer correctness.</p></div><div className="flow-status-legend"><span className="status-pill pass">✓ PASS</span><span className="status-pill warn">◐ PARTIAL</span><span className="status-pill fail">× FAIL</span></div></div>
            <div className="flow-form"><div className="flow-field"><label htmlFor="query-source">SOURCE DOCUMENT</label><div className="flow-select source-select">{document?.filename ?? "Upload a document first"}</div></div><div className="flow-field"><label htmlFor="query-input">YOUR QUESTION</label><textarea className="flow-input" id="query-input" value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={handleKeyDown} maxLength={500} placeholder="Ask something answerable from the uploaded document" /></div><button className="button button-primary" type="button" onClick={() => void runQuestion()} disabled={!document || processing?.stage !== "ready" || working}>{working ? (processing?.stage === "ready" ? "Evaluating…" : "Processing…") : "Ask & evaluate"}</button></div>
            <div className="flow-help">{question.length}/500 · Press ⌘/Ctrl + Enter to evaluate. Scores are heuristic signals, not validated benchmark measurements.</div>
            {working && processing?.stage === "ready" && <div className="flow-help operation-note" role="status" aria-live="polite">The document is ready; answer evaluation is still running. Local Ollama generation may take up to 60 seconds on this computer.</div>}
          </section>

          <section className="workbench-grid">
            <div className="panel test-panel" id="tests"><div className="panel-header"><div><div className="panel-kicker">KNOWN-ANSWER SET</div><h2>Evaluation cases</h2></div><button className="button button-quiet" type="button" onClick={() => document && void loadQuestions(document.id)} disabled={!document || working || !api}>{questionsReady ? "↻ Refresh questions" : "Load known questions"}</button></div><div className="case-list">{questions.length ? questions.map((item,index) => <button className={`case-row ${question === item.text ? "selected" : ""}`} type="button" key={item.id} onClick={() => setQuestion(item.text)}><span className="case-number">{String(index+1).padStart(2,"0")}</span><span className="case-query">{item.text}</span><span className="case-arrow">↗</span></button>) : <div className="empty-state">{document ? "Load known-answer questions for this document." : "Upload a document to see its known-answer questions."}</div>}</div><div className="case-footer"><span><i className="footer-dot" />{questions.length} known question{questions.length === 1 ? "" : "s"}</span><span>Click a case to fill the question</span></div></div>

            <div className="panel scores-panel"><div className="panel-header score-header"><div><div className="panel-kicker">CASE SCORECARD</div><h2>{result ? "Answer quality breakdown" : "Evaluation scores"}</h2></div><span className={`case-badge status-pill ${verdict?.state === "good" ? "pass" : verdict?.state === "bad" ? "fail" : "warn"}`}>{verdict?.label ?? "NOT RUN"}</span></div>
              <div className="score-columns"><ScoreBlock title="RETRIEVAL" evaluation={result?.evaluations.retrieval} color="blue"/><ScoreBlock title="ANSWER SUPPORT" evaluation={result?.evaluations.support} color="green"/><ScoreBlock title="CORRECTNESS" evaluation={result?.evaluations.correctness} color="amber"/></div>
              <div className="diagnosis">{result ? <><div className="diagnosis-icon">⌁</div><div><div className="diagnosis-title">{result.diagnosis.summary}</div><p>{result.diagnosis.plainLanguage}</p>{result.diagnosis.signals.length > 0 && <ul>{result.diagnosis.signals.slice(0,3).map((signal) => <li key={signal}>{signal}</li>)}</ul>}</div></> : <><div className="diagnosis-icon">⌁</div><div><div className="diagnosis-title">Select or enter a question</div><p>Run it to inspect retrieval, answer support, and correctness separately.</p></div></>}</div>
            </div>
          </section>

          <section className="evidence-grid">
            <div className="panel evidence-panel"><div className="panel-header evidence-heading"><div><div className="panel-kicker">RETRIEVAL OUTPUT · TOP CHUNKS</div><h2>Retrieved context</h2></div><span className="tiny-chip">{result ? `${result.evidence.length} CHUNKS` : "NOT RUN"}</span></div><div className="context-list">{result?.evidence.length ? result.evidence.map((item) => <article className="context-item" key={item.id}><div className="context-meta"><span className="context-source">{item.sourceFilename}</span>{item.pageNumber != null && <span>PAGE {item.pageNumber}</span>}{item.retrievalScore != null && <span>{Math.round(item.retrievalScore*100)}% MATCH</span>}</div><p className="context-text">{item.text}</p></article>) : <div className="empty-state">{result ? "No relevant context was retrieved for this question." : "Run an evaluation to inspect the retrieved passages."}</div>}</div></div>
            <div className="panel evidence-panel answer-panel"><div className="panel-header evidence-heading"><div><div className="panel-kicker">GENERATION OUTPUT · MODEL RESPONSE</div><h2>Final answer</h2></div><span className="tiny-chip">{result ? verdict?.label : "NOT RUN"}</span></div><div className="answer-content">{result ? <><p>{result.answer || "No answer was generated."}</p>{result.diagnosis.plainLanguage && <div className="answer-explanation">{result.diagnosis.plainLanguage}</div>}</> : <div className="empty-state">The generated answer will appear beside its source evidence.</div>}</div>{result && <div className="answer-meta">{result.model ?? "Local model"}{result.latencyMs ? ` · ${(result.latencyMs/1000).toFixed(2)}s` : ""}{result.isSample ? " · SAMPLE RESULT" : ""}</div>}</div>
          </section>
          <PhaseTwoPanel baseUrl={apiBaseUrl} activeDocumentId={document?.id ?? null} />
          <footer className="page-footer"><span>PROOFLINE <span className="footer-sep">/</span> RAG EVALUATION</span><span>{apiMode === "sample" ? "Demo adapter" : "Local backend"} · Scores are interpretable heuristics; review the evidence.</span></footer>
        </div>
      </main>
    </div>
  );
}

function ScoreBlock({ title, evaluation, color }: { title: string; evaluation?: Evaluation; color: "blue" | "green" | "amber" }) {
  const score = evaluation?.score == null ? null : Math.round(evaluation.score * 100);
  const outcome = evaluation ? outcomeCopy(evaluation) : { label: "NOT RUN", state: "unknown" };
  return <div className="score-block"><div className="score-block-head"><span>{title}</span><span className={`score-dot ${color}-dot`} /></div><div className="score-number"><b>{score ?? "—"}</b><small>{score == null ? "" : "/100"}</small></div><div className="score-track"><i className={`track-${color}`} style={{ width: `${score ?? 0}%` }} /></div><span className={`status-pill score-verdict ${outcome.state}`}>{outcome.label}</span><p>{evaluation?.rationale ?? "No evaluation available yet."}</p></div>;
}

export default App;
