/**
 * STATIC / NETLIFY MODE — Phase 2 with no backend.
 *
 * Everything here runs in the browser:
 *  - the QA set is fetched from `public/final_evaluated_dataset.json`,
 *  - reviewer labels are stored in localStorage,
 *  - the benchmark is the same deterministic extractive baseline the backend
 *    runs (lexical overlap, no model call), and
 *  - the confusion matrix, agreement metrics and throughput numbers are
 *    computed with the same rules as `backend/phase2.mjs`.
 *
 * It implements `Phase2Client`, the same interface `Phase2Api` satisfies, so
 * `PhaseTwoPanel` needs no branch of its own beyond picking this class when
 * `VITE_API_BASE_URL` is absent.
 */
import {
  FAILURE_TYPES,
  type AnnotationMetrics,
  type BenchmarkReport,
  type CompareReport,
  type FailureType,
  type Phase2Annotation,
  type Phase2Case,
  type Phase2Client,
  type Phase2Dataset,
  type Phase2DatasetSummary,
  type Phase2Document,
  type Phase2GenerationJob,
} from "./phase2Adapter";

const DATASET_URL = "final_evaluated_dataset.json";
const ANNOTATIONS_KEY = "phase2-local-annotations-v1";
const IMPORTS_KEY = "phase2-local-imports-v1";

const STOP = new Set(
  "a an the and or but if then than of in on at to for from by with as is are was were be been being it its this that these those what when where who how does do did can could will would should have has had".split(" "),
);

function tokens(value: string): string[] {
  return [...new Set((value.toLowerCase().match(/[a-z0-9]+/g) || []).filter((word) => word.length > 1 && !STOP.has(word)))];
}

function overlap(a: string, b: string): number {
  const aa = tokens(a);
  const bb = new Set(tokens(b));
  return aa.length ? aa.filter((word) => bb.has(word)).length / aa.length : 0;
}

function sentenceCandidates(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]?/g) || []).map((s) => s.trim()).filter((s) => s.length > 20);
}

interface RawCase {
  id: string;
  question: string;
  referenceAnswer: string;
  expectedEvidence?: string;
  expectedSource?: string;
  expectedPage?: number | null;
  annotations?: Phase2Annotation[];
  reviewer_1?: { failureType?: FailureType; answerCorrect?: boolean; evidenceRelevant?: boolean } | null;
  reviewer_2?: { failureType?: FailureType; answerCorrect?: boolean; evidenceRelevant?: boolean } | null;
}

interface RawDataset {
  name?: string;
  datasetId?: string;
  generationMetadata?: { sourceDocumentId?: string; sourceFilename?: string; model?: string; requestedCount?: number; generatedCount?: number } | null;
  cases?: RawCase[];
}

interface StoredDataset {
  id: string;
  name: string;
  documentId: string;
  createdAt: string;
  cases: Phase2Case[];
}

function cohenKappa(pairs: Phase2Annotation[][], getValue: (annotation: Phase2Annotation) => unknown): number | null {
  if (!pairs.length) return null;
  const labels = [...new Set(pairs.flatMap((pair) => [getValue(pair[0]), getValue(pair[1])]))];
  const observed = pairs.filter((pair) => getValue(pair[0]) === getValue(pair[1])).length / pairs.length;
  const expected = labels.reduce((sum, label) => {
    const first = pairs.filter((pair) => getValue(pair[0]) === label).length / pairs.length;
    const second = pairs.filter((pair) => getValue(pair[1]) === label).length / pairs.length;
    return sum + first * second;
  }, 0);
  return expected === 1 ? (observed === 1 ? 1 : 0) : Number(((observed - expected) / (1 - expected)).toFixed(3));
}

function annotationReport(dataset: { cases: Phase2Case[] }): AnnotationMetrics {
  const complete = dataset.cases.filter((item) => item.annotations.length === 2);
  const typeAgreement = complete.filter((item) => item.annotations[0].failureType === item.annotations[1].failureType).length;
  const correctnessAgreement = complete.filter((item) => item.annotations[0].answerCorrect === item.annotations[1].answerCorrect).length;
  const evidenceAgreement = complete.filter((item) => item.annotations[0].evidenceRelevant === item.annotations[1].evidenceRelevant).length;
  const fullAgreementCount = complete.filter((item) =>
    item.annotations[0].failureType === item.annotations[1].failureType &&
    item.annotations[0].answerCorrect === item.annotations[1].answerCorrect &&
    item.annotations[0].evidenceRelevant === item.annotations[1].evidenceRelevant,
  ).length;
  return {
    totalCases: dataset.cases.length,
    doubleLabeled: complete.length,
    fullAgreementCount,
    target150Progress: Math.min(100, Math.round(fullAgreementCount / 150 * 100)),
    failureTypeAgreement: complete.length ? Number((typeAgreement / complete.length).toFixed(3)) : null,
    failureTypeCohenKappa: cohenKappa(complete.map((item) => item.annotations), (label) => label.failureType),
    answerCorrectnessAgreement: complete.length ? Number((correctnessAgreement / complete.length).toFixed(3)) : null,
    evidenceRelevanceAgreement: complete.length ? Number((evidenceAgreement / complete.length).toFixed(3)) : null,
    consensusCount: complete.filter((item) => item.annotations[0].failureType === item.annotations[1].failureType).length,
  };
}

function consensusFailure(item: Phase2Case): FailureType | null {
  if (item.annotations.length !== 2 || item.annotations[0].failureType !== item.annotations[1].failureType) return null;
  return item.annotations[0].failureType;
}

function predictFailure(item: Phase2Case, result: { retrievedEvidence: Array<{ source: string; text: string }>; scores: { support: number | null; correctness: number | null } }): FailureType | null {
  if (!result.retrievedEvidence.length) return "retrieval_miss";
  const expectedSource = String(item.expectedSource || "").trim().toLowerCase();
  if (expectedSource && result.retrievedEvidence.every((evidence) => evidence.source.toLowerCase() !== expectedSource)) return "stale_source";
  let expectedEvidenceFound = false;
  if (String(item.expectedEvidence || "").trim()) {
    const terms = new Set((String(item.expectedEvidence).toLowerCase().match(/[a-z0-9]+/g) || []).filter((term) => term.length > 2));
    const evidenceTerms = new Set(result.retrievedEvidence.flatMap((evidence) => evidence.text.toLowerCase().match(/[a-z0-9]+/g) || []));
    const matched = [...terms].filter((term) => evidenceTerms.has(term)).length;
    expectedEvidenceFound = terms.size > 0 && matched / terms.size >= 0.25;
    if (terms.size && !expectedEvidenceFound) return "wrong_chunk";
  }
  if ((result.scores.support ?? 1) < 0.45) return "unsupported_claim";
  if (result.scores.correctness != null && result.scores.correctness < 0.5) {
    return expectedEvidenceFound ? "ignored_context" : "incorrect_answer";
  }
  return "none";
}

const DIAGNOSES: Record<FailureType, string> = {
  none: "No failure signal crossed the configured heuristic thresholds.",
  retrieval_miss: "No relevant passage was retrieved for this question.",
  wrong_chunk: "Retrieved passages did not contain the expected evidence.",
  ignored_context: "Expected evidence was retrieved, but the answer did not use it correctly.",
  unsupported_claim: "The answer has little lexical support in the retrieved text.",
  stale_source: "The expected source was not present in the retrieved evidence.",
  incorrect_answer: "The answer has low lexical agreement with the reference answer.",
};

interface LocalResult {
  caseId: string;
  question: string;
  answer: string;
  retrievedEvidence: Array<{ text: string; source: string; page: number | null; retrievalScore: number }>;
  predictedFailure: FailureType | null;
  diagnosis: string;
  scores: { retrieval: number; support: number; correctness: number | null };
  status: string;
  evidenceCount: number;
}

interface Chunk { text: string; source: string; page: number | null; terms: Set<string> }

/** Rebuild a searchable corpus from the cases' expected evidence, grouped per page. */
function buildChunks(cases: Phase2Case[]): Chunk[] {
  const groups = new Map<string, { source: string; page: number | null; texts: string[] }>();
  for (const item of cases) {
    const key = `${item.expectedSource || "document"}|${item.expectedPage ?? ""}`;
    const group = groups.get(key) || { source: item.expectedSource || "document", page: item.expectedPage ?? null, texts: [] };
    const text = String(item.expectedEvidence || "").trim();
    if (text && !group.texts.includes(text)) group.texts.push(text);
    groups.set(key, group);
  }
  const chunks: Chunk[] = [];
  const max = 900;
  const overlapBy = 120;
  for (const group of groups.values()) {
    const joined = group.texts.join(" ").replace(/\s+/g, " ").trim();
    if (joined.length < 25) continue;
    for (let start = 0; start < joined.length; start += max - overlapBy) {
      const text = joined.slice(start, start + max).trim();
      if (text.length > 25) chunks.push({ text, source: group.source, page: group.page, terms: new Set(tokens(text)) });
    }
  }
  return chunks;
}

function evaluateLocal(item: Phase2Case, chunks: Chunk[], config: { topK: number; minScore: number }, answerOverride?: string): LocalResult {
  const searchTerms = tokens(item.question);
  const ranked = chunks
    .map((chunk) => ({ chunk, score: searchTerms.length ? searchTerms.filter((term) => chunk.terms.has(term)).length / searchTerms.length : 0 }))
    .filter((entry) => entry.score > 0 && entry.score >= config.minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, config.topK);
  const evidence = ranked.map((entry) => entry.chunk);
  const context = evidence.map((chunk) => chunk.text).join(" ");
  const sentences = evidence.flatMap((chunk) => sentenceCandidates(chunk.text).map((text) => ({ text, score: overlap(item.question, text) })));
  const extractive = sentences.sort((a, b) => b.score - a.score)[0]?.text || "I could not find a passage in this document that answers that question.";
  const answer = (answerOverride ?? extractive).trim();

  const retrievedTerms = new Set(tokens(context));
  const referenceTerms = tokens(item.expectedEvidence || item.referenceAnswer || item.question);
  const retrieval = referenceTerms.length ? referenceTerms.filter((term) => retrievedTerms.has(term)).length / referenceTerms.length : 0;
  const answerTerms = tokens(answer);
  const support = answerTerms.length ? answerTerms.filter((term) => retrievedTerms.has(term)).length / answerTerms.length : 0;
  const correctness = overlap(item.referenceAnswer, answer);

  const noEvidence = evidence.length === 0;
  const unsupported = noEvidence || support < 0.45;
  const correct = correctness >= 0.5;
  let status: string;
  let diagnosis: string;
  if (unsupported) {
    status = "unsupported";
    diagnosis = noEvidence ? "The relevant passage was not retrieved, so the system abstained." : "The answer is not supported by the retrieved text.";
  } else if (!correct) {
    status = "incorrect";
    diagnosis = "Relevant text was retrieved, but the answer does not match the known answer.";
  } else {
    status = "supported";
    diagnosis = "The answer is supported by the retrieved text and agrees with the known answer.";
  }

  const retrievedEvidence = evidence.map((chunk) => ({ text: chunk.text, source: chunk.source, page: chunk.page, retrievalScore: 0 }));
  const scores = {
    retrieval: Number(retrieval.toFixed(3)),
    support: Number(support.toFixed(3)),
    correctness: Number(correctness.toFixed(3)),
  };
  const predictedFailure = predictFailure(item, { retrievedEvidence, scores });
  return {
    caseId: item.id,
    question: item.question,
    answer,
    retrievedEvidence,
    predictedFailure,
    diagnosis: DIAGNOSES[predictedFailure || "none"],
    scores,
    status,
    evidenceCount: evidence.length,
  };
}

function confusionMatrix(results: LocalResult[], cases: Phase2Case[]): BenchmarkReport["confusion"] {
  const labels = FAILURE_TYPES;
  const matrix = Object.fromEntries(labels.map((gold) => [gold, Object.fromEntries(labels.map((predicted) => [predicted, 0]))])) as BenchmarkReport["confusion"]["matrix"];
  const caseById = new Map(cases.map((item) => [item.id, item]));
  let aligned = 0;
  let unreviewed = 0;
  let disagreement = 0;
  let invalid = 0;
  let duplicate = 0;
  const grouped = new Map<string, LocalResult[]>();
  for (const result of results) {
    const list = grouped.get(result.caseId) || [];
    list.push(result);
    grouped.set(result.caseId, list);
  }
  for (const [caseId, rows] of grouped) {
    if (rows.length !== 1) { duplicate += rows.length; continue; }
    const item = caseById.get(caseId);
    if (!item || item.annotations.length < 2) { unreviewed += 1; continue; }
    const gold = consensusFailure(item);
    if (gold == null) { disagreement += 1; continue; }
    const predicted = rows[0].predictedFailure;
    if (!labels.includes(gold) || !predicted || !labels.includes(predicted)) { invalid += 1; continue; }
    matrix[gold][predicted] += 1;
    if (gold === predicted) aligned += 1;
  }
  const count = Object.values(matrix).reduce((sum, row) => sum + Object.values(row).reduce((a, b) => a + b, 0), 0);
  return {
    labels, matrix, comparedPairs: count,
    excludedPairs: { unreviewed, reviewerDisagreement: disagreement, invalidPrediction: invalid, duplicateResult: duplicate },
    pipelineAgreement: count ? Number((aligned / count).toFixed(3)) : null,
  };
}

function averageScores(results: LocalResult[]): { retrieval: number | null; support: number | null; correctness: number | null } {
  const keys = ["retrieval", "support", "correctness"] as const;
  return Object.fromEntries(keys.map((key) => {
    const values = results.map((item) => item.scores[key]).filter((value) => value != null) as number[];
    return [key, values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3)) : null];
  })) as { retrieval: number | null; support: number | null; correctness: number | null };
}

function performance(count: number, durationMs: number): BenchmarkReport["performance"] {
  const questionsPerMinute = durationMs > 0 ? Math.round(count / (durationMs / 60000)) : count * 60;
  return {
    questionCount: count,
    targetQuestionCount: 150,
    durationMs,
    questionsPerMinute,
    under15Minutes: durationMs < 15 * 60 * 1000,
    meets200QuestionTarget: count >= 200,
  };
}

const SCORING_NOTE = "Deterministic extractive baseline over the document's own passages: lexical overlap in [0,1], no model call and no network request. These are transparent demo signals, not validated evaluation metrics.";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }
}

function writeJson(key: string, value: unknown): void {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage is optional; labels live for this session. */ }
}

/** Maps a shipped AI-generated reviewer field onto a real Phase 2 annotation. */
function annotationFrom(raw: RawCase["reviewer_1"], annotatorId: string): Phase2Annotation | null {
  if (!raw || !raw.failureType) return null;
  return {
    annotatorId,
    failureType: raw.failureType,
    answerCorrect: Boolean(raw.answerCorrect),
    evidenceRelevant: Boolean(raw.evidenceRelevant),
    updatedAt: undefined,
  };
}

export class LocalPhase2Api implements Phase2Client {
  readonly localDocumentId: string;

  private readonly loaded: Promise<StoredDataset[]>;
  private readonly documents: Phase2Document[];

  constructor() {
    const source = DATASET_URL;
    this.localDocumentId = "local-static";
    this.documents = [{ id: this.localDocumentId, filename: "sample source", pageCount: null, sizeBytes: null, createdAt: new Date().toISOString() }];
    this.loaded = this.load();
  }

  private async load(): Promise<StoredDataset[]> {
    const stored = readJson<StoredDataset[]>(IMPORTS_KEY, []);
    let raw: RawDataset | null = null;
    try {
      const response = await fetch(DATASET_URL, { cache: "no-cache" });
      if (response.ok) raw = (await response.json()) as RawDataset;
    } catch { /* Missing file is reported by the caller, not thrown here. */ }
    if (!raw || !Array.isArray(raw.cases) || !raw.cases.length) {
      if (stored.length) return stored;
      throw new Error(`Could not load ${source}. Add it to the public/ directory.`);
    }
    const shipped: StoredDataset = {
      id: raw.datasetId || "final-evaluated-dataset",
      name: raw.name || "Final evaluated dataset",
      documentId: this.localDocumentId,
      createdAt: "2026-10-25T00:00:00.000Z",
      cases: raw.cases.map((item, index) => ({
        id: item.id || `case-${index + 1}`,
        question: item.question,
        referenceAnswer: item.referenceAnswer,
        expectedEvidence: item.expectedEvidence || "",
        expectedSource: item.expectedSource || raw?.generationMetadata?.sourceFilename || "document",
        expectedPage: item.expectedPage ?? null,
        annotations: [
          annotationFrom(item.reviewer_1, "reviewer-1"),
          annotationFrom(item.reviewer_2, "reviewer-2"),
        ].filter((entry): entry is Phase2Annotation => entry !== null),
      })),
    };
    const filename = shipped.cases[0]?.expectedSource || "document";
    this.documents = [{ id: this.localDocumentId, filename, pageCount: null, sizeBytes: null, createdAt: new Date().toISOString() }];
    return [shipped, ...stored];
  }

  private async withAnnotations(dataset: StoredDataset): Promise<Phase2Dataset> {
    const saved = readJson<Record<string, Phase2Annotation[]>>(ANNOTATIONS_KEY, {});
    const overrides = saved[dataset.id] || {};
    const cases = dataset.cases.map((item) => ({
      ...item,
      annotations: overrides[item.id] ? overrides[item.id] : item.annotations,
    }));
    const report = annotationReport({ cases });
    return {
      id: dataset.id,
      name: dataset.name,
      cases,
      generationMetadata: { method: "static-local", generatedCount: cases.length, humanReviewed: report.doubleLabeled > 0 },
      ...report,
    };
  }

  async listDocuments(): Promise<Phase2Document[]> { return this.documents; }

  async listDatasets(): Promise<Phase2DatasetSummary[]> {
    const datasets = await this.loaded;
    return datasets.map((dataset) => {
      const report = annotationReport(dataset);
      return {
        id: dataset.id,
        name: dataset.name,
        documentId: dataset.documentId,
        createdAt: dataset.createdAt,
        totalCases: report.totalCases,
        doubleLabeled: report.doubleLabeled,
        target150Progress: report.target150Progress,
      };
    });
  }

  async getDataset(id: string): Promise<Phase2Dataset> {
    const datasets = await this.loaded;
    const dataset = datasets.find((item) => item.id === id);
    if (!dataset) throw new Error("Dataset not found");
    return this.withAnnotations(dataset);
  }

  async createDataset(payload: unknown): Promise<Phase2Dataset> {
    const body = payload as { name?: string; cases?: RawCase[] };
    if (!body || !Array.isArray(body.cases) || !body.cases.length) throw new Error("Dataset must contain a cases array.");
    const id = `local-${Date.now().toString(36)}`;
    const dataset: StoredDataset = {
      id,
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Imported QA set",
      documentId: this.localDocumentId,
      createdAt: new Date().toISOString(),
      cases: body.cases.map((item, index) => ({
        id: item.id || `case-${index + 1}`,
        question: String(item.question || ""),
        referenceAnswer: String(item.referenceAnswer || ""),
        expectedEvidence: item.expectedEvidence || "",
        expectedSource: item.expectedSource || this.documents[0].filename,
        expectedPage: item.expectedPage ?? null,
        annotations: [],
      })),
    };
    const stored = readJson<StoredDataset[]>(IMPORTS_KEY, []);
    writeJson(IMPORTS_KEY, [...stored, dataset]);
    this.loaded.then((list) => list.push(dataset)).catch(() => undefined);
    return this.withAnnotations(dataset);
  }

  async generateDataset(): Promise<Phase2GenerationJob> {
    throw new Error("Static deployment: question generation runs on the backend. The prepared 150-pair set is already loaded.");
  }

  async getGenerationJob(id: string): Promise<Phase2GenerationJob> {
    throw new Error(`Generation job ${id} is not available in static mode.`);
  }

  async saveAnnotation(datasetId: string, caseId: string, annotation: Omit<Phase2Annotation, "updatedAt">): Promise<Phase2Dataset> {
    const full: Phase2Annotation = { ...annotation, updatedAt: new Date().toISOString() };
    const saved = readJson<Record<string, Phase2Annotation[]>>(ANNOTATIONS_KEY, {});
    const datasets = await this.loaded;
    const dataset = datasets.find((item) => item.id === datasetId);
    const base = dataset?.cases.find((item) => item.id === caseId);
    if (!base) throw new Error("Question pair not found in this dataset");
    const existing = [...base.annotations];
    const index = existing.findIndex((entry) => entry.annotatorId === full.annotatorId);
    if (index < 0 && existing.length >= 2) throw new Error("This pair already has two annotators; use one of their IDs to revise a label");
    if (index < 0) existing.push(full); else existing[index] = full;
    saved[datasetId] = { ...(saved[datasetId] || {}), [caseId]: existing };
    writeJson(ANNOTATIONS_KEY, saved);
    return this.getDataset(datasetId);
  }

  async runBenchmark(_documentId: string, datasetId: string, answers?: Array<{ caseId: string; answer: string }>): Promise<BenchmarkReport> {
    const dataset = await this.getDataset(datasetId);
    const chunks = buildChunks(dataset.cases);
    const override = new Map((answers || []).map((row) => [row.caseId, row.answer]));
    const config = { topK: 3, minScore: 0.01 };
    const started = Date.now();
    const results = dataset.cases.map((item) => evaluateLocal(item, chunks, config, override.get(item.id)));
    const durationMs = Math.max(1, Date.now() - started);
    const document = this.documents[0];
    return {
      dataset: { id: dataset.id, name: dataset.name },
      document: { id: document.id, filename: document.filename },
      annotationMetrics: annotationReport(dataset),
      confusion: confusionMatrix(results, dataset.cases),
      aggregateScores: averageScores(results),
      performance: performance(results.length, durationMs),
      evaluationMode: answers?.length ? "external_answers" : "extractive_baseline",
      results,
      scoringNote: SCORING_NOTE,
    };
  }

  async compare(input: {
    baselineDocumentId: string; candidateDocumentId: string; datasetId: string;
    baselineConfig: { topK: number; minScore: number };
    candidateConfig: { topK: number; minScore: number };
    baselineLabel?: string; candidateLabel?: string;
  }): Promise<CompareReport> {
    const dataset = await this.getDataset(input.datasetId);
    const chunks = buildChunks(dataset.cases);
    const baselineStart = Date.now();
    const baselineResults = dataset.cases.map((item) => evaluateLocal(item, chunks, input.baselineConfig));
    const baselineMs = Math.max(1, Date.now() - baselineStart);
    const candidateStart = Date.now();
    const candidateResults = dataset.cases.map((item) => evaluateLocal(item, chunks, input.candidateConfig));
    const candidateMs = Math.max(1, Date.now() - candidateStart);
    const document = this.documents[0];
    const regressions = candidateResults.map((candidate, index) => {
      const baseline = baselineResults[index];
      const signals: string[] = [];
      if (baseline.status === "supported" && candidate.status !== "supported") signals.push("status changed from supported to failed");
      for (const key of ["retrieval", "support"] as const) {
        const before = baseline.scores[key];
        const after = candidate.scores[key];
        if (before != null && after != null && after <= before - 0.1) signals.push(`${key} decreased by ${Math.round((before - after) * 100)} points`);
      }
      return { caseId: candidate.caseId, question: candidate.question, baseline, candidate, signals, regressed: signals.length > 0 };
    }).filter((row) => row.regressed);
    const durationMs = baselineMs + candidateMs;
    return {
      questionCount: dataset.cases.length,
      baseline: {
        label: input.baselineLabel || `${document.filename} · topK ${input.baselineConfig.topK}`,
        filename: document.filename,
        config: input.baselineConfig,
        averageScores: averageScores(baselineResults),
      },
      candidate: {
        label: input.candidateLabel || `${document.filename} · topK ${input.candidateConfig.topK}`,
        filename: document.filename,
        config: input.candidateConfig,
        averageScores: averageScores(candidateResults),
      },
      regressionCount: regressions.length,
      regressions: regressions.map((row) => ({ caseId: row.caseId, question: row.question, signals: row.signals })),
      performance: performance(dataset.cases.length * 2, durationMs),
      scoringNote: SCORING_NOTE,
    };
  }
}
