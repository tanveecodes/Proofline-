export const FAILURE_TYPES = [
  "none",
  "retrieval_miss",
  "wrong_chunk",
  "ignored_context",
  "unsupported_claim",
  "stale_source",
  "incorrect_answer",
] as const;

export type FailureType = typeof FAILURE_TYPES[number];
export interface Phase2Annotation {
  annotatorId: string;
  failureType: FailureType;
  answerCorrect: boolean;
  evidenceRelevant: boolean;
  updatedAt?: string;
}
export interface Phase2Case {
  id: string;
  question: string;
  referenceAnswer: string;
  expectedEvidence: string;
  expectedSource: string;
  expectedPage?: number | null;
  annotations: Phase2Annotation[];
}
export interface Phase2Dataset {
  id: string;
  name: string;
  cases: Phase2Case[];
  generationMetadata?: { method: string; generatedCount: number; humanReviewed: boolean } | null;
  totalCases: number;
  doubleLabeled: number;
  fullAgreementCount: number;
  target150Progress: number;
  failureTypeAgreement: number | null;
  failureTypeCohenKappa: number | null;
  answerCorrectnessAgreement: number | null;
  evidenceRelevanceAgreement: number | null;
  consensusCount: number;
}
export interface Phase2DatasetSummary {
  id: string;
  name: string;
  documentId: string | null;
  createdAt: string | null;
  totalCases: number;
  doubleLabeled: number;
  target150Progress: number;
}
export interface Phase2GenerationJob {
  id: string;
  documentId: string;
  filename: string;
  status: "queued" | "running" | "complete" | "partial" | "failed";
  requestedCount: number;
  generatedCount: number;
  progress: number;
  completedBatches: number;
  totalBatches: number;
  datasetId: string | null;
  error: string | null;
}
export interface Phase2Document {
  id: string;
  filename: string;
  pageCount: number | null;
  sizeBytes: number | null;
  createdAt: string | null;
}
export interface AnnotationMetrics {
  totalCases: number;
  doubleLabeled: number;
  fullAgreementCount: number;
  target150Progress: number;
  failureTypeAgreement: number | null;
  failureTypeCohenKappa: number | null;
  answerCorrectnessAgreement: number | null;
  evidenceRelevanceAgreement: number | null;
  consensusCount: number;
}
export interface BenchmarkReport {
  dataset: { id: string; name: string };
  document: { id: string; filename: string };
  annotationMetrics: AnnotationMetrics;
  confusion: {
    labels: FailureType[];
    matrix: Record<FailureType, Record<FailureType, number>>;
    comparedPairs: number;
    excludedPairs: { unreviewed: number; reviewerDisagreement: number; invalidPrediction: number; duplicateResult: number };
    pipelineAgreement: number | null;
  };
  aggregateScores: { retrieval: number | null; support: number | null; correctness: number | null };
  performance: { questionCount: number; targetQuestionCount: number; durationMs: number; questionsPerMinute: number; under15Minutes: boolean; meets200QuestionTarget: boolean };
  evaluationMode: "external_answers" | "extractive_baseline";
  results: Array<{
    caseId: string;
    question: string;
    answer: string;
    retrievedEvidence: Array<{ text: string; source: string; page: number | null; retrievalScore: number }>;
    predictedFailure: FailureType | null;
    diagnosis: string;
    scores: { retrieval: number; support: number; correctness: number | null };
    status: string;
    evidenceCount: number;
  }>;
  scoringNote: string;
}
export interface CompareReport {
  questionCount: number;
  baseline: { label: string; filename: string; config: { topK: number; minScore: number }; averageScores: { retrieval: number | null; support: number | null; correctness: number | null } };
  candidate: { label: string; filename: string; config: { topK: number; minScore: number }; averageScores: { retrieval: number | null; support: number | null; correctness: number | null } };
  regressionCount: number;
  regressions: Array<{ caseId: string; question: string; signals: string[] }>;
  performance: { questionCount: number; targetQuestionCount: number; durationMs: number; questionsPerMinute: number; under15Minutes: boolean; meets200QuestionTarget: boolean };
  scoringNote: string;
}

export class Phase2Api {
  private localDatasetPromise: Promise<Phase2Dataset> | null = null;
  private readonly localDocumentId = "proofline-static-sample";

  constructor(private readonly baseUrl: string | null) {}

  private localDataset(): Promise<Phase2Dataset> {
    if (!this.localDatasetPromise) {
      this.localDatasetPromise = (async () => {
        let source: Record<string, unknown>;
        try {
          const response = await fetch(`${import.meta.env.BASE_URL}final_evaluated_dataset.json`);
          if (!response.ok) throw new Error(`Dataset request failed (${response.status})`);
          source = await response.json() as Record<string, unknown>;
        } catch {
          throw new Error("Could not load public/final_evaluated_dataset.json. Confirm the file is in the public folder and rebuild the site.");
        }
        const rawCases = Array.isArray(source.cases) ? source.cases as Array<Record<string, unknown>> : [];
        if (!rawCases.length) throw new Error("The local Phase 2 JSON contains no cases.");
        let annotationsByCase: Record<string, Phase2Annotation[]> = {};
        try {
          annotationsByCase = JSON.parse(localStorage.getItem("proofline-phase2-annotations-v1") || "{}");
        } catch { /* Ignore invalid local browser storage and use clean labels. */ }
        const cases: Phase2Case[] = rawCases.map((row, index) => {
          const id = typeof row.id === "string" ? row.id : `local-case-${index + 1}`;
          const saved = annotationsByCase[id];
          const imported = Array.isArray(row.annotations) ? row.annotations as Phase2Annotation[] : [];
          return {
            id,
            question: String(row.question || ""),
            referenceAnswer: String(row.referenceAnswer || row.reference_answer || ""),
            expectedEvidence: String(row.expectedEvidence || row.retrieved_context || ""),
            expectedSource: String(row.expectedSource || "Local sample document"),
            expectedPage: typeof row.expectedPage === "number" ? row.expectedPage : null,
            annotations: saved || imported,
          };
        });
        const dataset: Phase2Dataset = {
          id: String(source.datasetId || "proofline-local-150"),
          name: String(source.name || "Local Phase 2 QA candidate set"),
          cases,
          generationMetadata: source.generationMetadata as Phase2Dataset["generationMetadata"],
          ...localAnnotationReport(cases),
        };
        return dataset;
      })();
    }
    return this.localDatasetPromise;
  }

  private async request<T>(path: string, body?: unknown): Promise<T> {
    if (!this.baseUrl) throw new Error("This action requires the backend and is unavailable in static-data mode.");
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(125_000),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new Error("Phase 2 analysis took too long. Check the backend and try again.");
      }
      throw new Error("Could not reach the backend. Check that it is running.");
    }
    const payload = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || `Phase 2 request failed (${response.status})`);
    return payload;
  }

  async listDocuments() {
    if (!this.baseUrl) {
      const dataset = await this.localDataset();
      const filename = dataset.cases.find((row) => row.expectedSource)?.expectedSource || "Local sample document";
      return [{ id: this.localDocumentId, filename, pageCount: Math.max(0, ...dataset.cases.map((row) => row.expectedPage || 0)) || null, sizeBytes: null, createdAt: null }];
    }
    return this.request<Phase2Document[]>("/documents");
  }
  listDatasets(documentId?: string) {
    if (!this.baseUrl) return this.localDataset().then((dataset) => [{ id: dataset.id, name: dataset.name, documentId: this.localDocumentId, createdAt: null, totalCases: dataset.totalCases, doubleLabeled: dataset.doubleLabeled, target150Progress: dataset.target150Progress }]);
    const query = documentId ? `?documentId=${encodeURIComponent(documentId)}` : "";
    return this.request<Phase2DatasetSummary[]>(`/phase2/datasets${query}`);
  }
  async getDataset(id: string) {
    if (!this.baseUrl) {
      const dataset = await this.localDataset();
      if (dataset.id !== id) throw new Error("Local dataset not found.");
      return { ...dataset, ...localAnnotationReport(dataset.cases) };
    }
    return this.request<Phase2Dataset>(`/phase2/datasets/${encodeURIComponent(id)}`);
  }
  createDataset(payload: unknown) {
    if (!this.baseUrl) return Promise.reject(new Error("Importing a new dataset is unavailable in static preview mode; use the supplied local dataset."));
    return this.request<Phase2Dataset>("/phase2/datasets", payload);
  }
  generateDataset(documentId: string, count: number) {
    if (!this.baseUrl) return Promise.reject(new Error("Automatic Llama generation requires the backend. The local static dataset is ready to review."));
    return this.request<Phase2GenerationJob>("/phase2/generate-dataset", { documentId, count });
  }
  getGenerationJob(id: string) { return this.request<Phase2GenerationJob>(`/phase2/generation-jobs/${encodeURIComponent(id)}`); }
  saveAnnotation(datasetId: string, caseId: string, annotation: Omit<Phase2Annotation, "updatedAt">) {
    if (!this.baseUrl) return this.localDataset().then((dataset) => {
      if (dataset.id !== datasetId) throw new Error("Local dataset not found.");
      const row = dataset.cases.find((item) => item.id === caseId);
      if (!row) throw new Error("Question pair not found.");
      const next = { ...annotation, updatedAt: new Date().toISOString() };
      const index = row.annotations.findIndex((item) => item.annotatorId === next.annotatorId);
      if (index < 0 && row.annotations.length >= 2) throw new Error("This pair already has two reviewers; use one of their IDs to revise a label.");
      if (index < 0) row.annotations.push(next); else row.annotations[index] = next;
      this.persistLocalAnnotations(dataset.cases);
      return { ...dataset, ...localAnnotationReport(dataset.cases) };
    });
    return this.request<Phase2Dataset>(`/phase2/datasets/${encodeURIComponent(datasetId)}/annotations`, { caseId, annotation });
  }
  runBenchmark(documentId: string, datasetId: string, answers?: Array<{ caseId: string; answer: string }>) {
    if (!this.baseUrl) return this.localDataset().then((dataset) => {
      if (dataset.id !== datasetId) throw new Error("Local dataset not found.");
      const answerById = new Map((answers || []).map((row) => [row.caseId, row.answer]));
      const started = performance.now();
      const results = dataset.cases.map((item) => {
        const answer = answerById.get(item.id) || item.referenceAnswer;
        const retrieval = tokenOverlap(item.question, item.expectedEvidence);
        const support = tokenOverlap(answer, item.expectedEvidence);
        const correctness = tokenOverlap(answer, item.referenceAnswer);
        const evidence = retrieval >= 0.08 ? [{ text: item.expectedEvidence, source: item.expectedSource, page: item.expectedPage ?? null, retrievalScore: retrieval }] : [];
        const failure: FailureType = evidence.length === 0 ? "retrieval_miss" : support < 0.25 ? "unsupported_claim" : correctness < 0.35 ? "incorrect_answer" : "none";
        const diagnoses: Record<FailureType, string> = {
          none: "The local reference fixture matched its saved evidence and answer.",
          retrieval_miss: "The local lexical matcher did not find enough query terms in the saved evidence.",
          wrong_chunk: "The retrieved evidence differs from the expected passage.",
          ignored_context: "Relevant text was present, but the answer did not use it.",
          unsupported_claim: "The answer has low lexical support in the saved source evidence.",
          stale_source: "The evidence source does not match the expected source.",
          incorrect_answer: "The answer has low lexical agreement with the reference answer.",
        };
        return { caseId: item.id, question: item.question, answer, retrievedEvidence: evidence, predictedFailure: failure, diagnosis: diagnoses[failure], scores: { retrieval, support, correctness }, status: failure === "none" ? "supported" : "failed", evidenceCount: evidence.length };
      });
      const durationMs = Math.max(1, performance.now() - started);
      const confusion = localConfusion(results, dataset.cases);
      return {
        dataset: { id: dataset.id, name: dataset.name }, document: { id: documentId || this.localDocumentId, filename: dataset.cases[0]?.expectedSource || "Local sample" },
        annotationMetrics: localAnnotationReport(dataset.cases), confusion, aggregateScores: localAverages(results.map((row) => row.scores)),
        performance: { questionCount: results.length, targetQuestionCount: 200, durationMs: Math.round(durationMs), questionsPerMinute: Number((results.length * 60000 / durationMs).toFixed(1)), under15Minutes: durationMs <= 900000, meets200QuestionTarget: results.length >= 200 && durationMs <= 900000 },
        results, evaluationMode: answers ? "external_answers" as const : "extractive_baseline" as const,
        scoringNote: "Static local preview: deterministic lexical checks use the supplied candidate's saved reference answer/evidence as a fixture. This demonstrates the dashboard flow; it is not a run against a live RAG system and does not establish scientific accuracy. Reviewer agreement counts only labels saved independently in this browser.",
      };
    });
    return this.request<BenchmarkReport>("/phase2/benchmark", { documentId, datasetId, ...(answers ? { answers } : {}) });
  }
  compare(input: { baselineDocumentId: string; candidateDocumentId: string; datasetId: string; baselineConfig: { topK: number; minScore: number }; candidateConfig: { topK: number; minScore: number }; baselineLabel?: string; candidateLabel?: string }) {
    if (!this.baseUrl) return this.localDataset().then((dataset) => {
      const started = performance.now();
      const scoreAt = (item: Phase2Case, config: { topK: number; minScore: number }) => {
        const retrieval = tokenOverlap(item.question, item.expectedEvidence);
        const evidence = retrieval >= config.minScore && config.topK > 0 ? item.expectedEvidence : "";
        const support = evidence ? tokenOverlap(item.referenceAnswer, evidence) : 0;
        return { retrieval: evidence ? retrieval : 0, support, correctness: tokenOverlap(item.referenceAnswer, item.referenceAnswer) };
      };
      const baselineScores = dataset.cases.map((item) => scoreAt(item, input.baselineConfig));
      const candidateScores = dataset.cases.map((item) => scoreAt(item, input.candidateConfig));
      const baseline = { label: input.baselineLabel || "Baseline · local lexical", filename: dataset.cases[0]?.expectedSource || "Local fixture", config: input.baselineConfig, averageScores: localAverages(baselineScores) };
      const candidate = { label: input.candidateLabel || "Candidate · local lexical", filename: dataset.cases[0]?.expectedSource || "Local fixture", config: input.candidateConfig, averageScores: localAverages(candidateScores) };
      const regressions = dataset.cases.flatMap((item, index) => {
        const before = baselineScores[index]; const after = candidateScores[index];
        const signals = ["retrieval", "support", "correctness"].filter((key) => before[key as keyof typeof before] - after[key as keyof typeof after] >= 0.1).map((key) => `${key} score fell by 10+ points`);
        return signals.length ? [{ caseId: item.id, question: item.question, signals }] : [];
      });
      const durationMs = Math.max(1, performance.now() - started);
      return { questionCount: dataset.cases.length, baseline, candidate, regressionCount: regressions.length, regressions,
        performance: { questionCount: dataset.cases.length * 2, targetQuestionCount: 200, durationMs: Math.round(durationMs), questionsPerMinute: Number((dataset.cases.length * 2 * 60000 / durationMs).toFixed(1)), under15Minutes: durationMs <= 900000, meets200QuestionTarget: dataset.cases.length >= 100 && durationMs <= 900000 },
        scoringNote: "Static preview comparison uses the same local reference fixtures and deterministic token overlap. It demonstrates regression UI mechanics; it is not a comparison between two deployed RAG systems." };
    });
    return this.request<CompareReport>("/phase2/compare", input);
  }

  private persistLocalAnnotations(cases: Phase2Case[]) {
    const stored = Object.fromEntries(cases.filter((item) => item.annotations.length).map((item) => [item.id, item.annotations]));
    try { localStorage.setItem("proofline-phase2-annotations-v1", JSON.stringify(stored)); }
    catch { throw new Error("Could not save reviewer labels in this browser. Check local storage availability."); }
  }
}

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => word.length > 1) || []);
}

function tokenOverlap(first: string, second: string): number {
  const a = words(first); const b = words(second);
  if (!a.size) return 0;
  return [...a].filter((word) => b.has(word)).length / a.size;
}

function localAnnotationReport(cases: Phase2Case[]) {
  const complete = cases.filter((item) => item.annotations.length === 2);
  const agreement = (selector: (annotation: Phase2Annotation) => unknown) => complete.length
    ? complete.filter((item) => selector(item.annotations[0]) === selector(item.annotations[1])).length / complete.length
    : null;
  const failureAgreement = agreement((item) => item.failureType);
  const labels = [...new Set(complete.flatMap((item) => item.annotations.map((annotation) => annotation.failureType)))];
  const expected = labels.reduce((sum, label) => {
    const first = complete.filter((item) => item.annotations[0].failureType === label).length / (complete.length || 1);
    const second = complete.filter((item) => item.annotations[1].failureType === label).length / (complete.length || 1);
    return sum + first * second;
  }, 0);
  const kappa = failureAgreement == null ? null : expected === 1 ? (failureAgreement === 1 ? 1 : 0) : Number(((failureAgreement - expected) / (1 - expected)).toFixed(3));
  const fullAgreementCount = complete.filter((item) => ["failureType", "answerCorrect", "evidenceRelevant"].every((key) => item.annotations[0][key as keyof Phase2Annotation] === item.annotations[1][key as keyof Phase2Annotation])).length;
  return { totalCases: cases.length, doubleLabeled: complete.length, fullAgreementCount, target150Progress: Math.min(100, Math.round(fullAgreementCount / 150 * 100)), failureTypeAgreement: failureAgreement == null ? null : Number(failureAgreement.toFixed(3)), failureTypeCohenKappa: kappa,
    answerCorrectnessAgreement: agreement((item) => item.answerCorrect), evidenceRelevanceAgreement: agreement((item) => item.evidenceRelevant), consensusCount: complete.filter((item) => item.annotations[0].failureType === item.annotations[1].failureType).length };
}

function localAverages(items: Array<{ retrieval: number | null; support: number | null; correctness: number | null }>) {
  return Object.fromEntries((['retrieval', 'support', 'correctness'] as const).map((key) => {
    const values = items.map((item) => item[key]).filter((value): value is number => value != null);
    return [key, values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3)) : null];
  })) as { retrieval: number | null; support: number | null; correctness: number | null };
}

function localConfusion(results: Array<{ caseId: string; predictedFailure: FailureType }>, cases: Phase2Case[]) {
  const labels = FAILURE_TYPES;
  const matrix = Object.fromEntries(labels.map((actual) => [actual, Object.fromEntries(labels.map((predicted) => [predicted, 0]))])) as Record<FailureType, Record<FailureType, number>>;
  const byId = new Map(cases.map((item) => [item.id, item]));
  let comparedPairs = 0; let unreviewed = 0; let reviewerDisagreement = 0;
  for (const result of results) {
    const item = byId.get(result.caseId);
    if (!item || item.annotations.length < 2) { unreviewed++; continue; }
    if (item.annotations[0].failureType !== item.annotations[1].failureType) { reviewerDisagreement++; continue; }
    matrix[item.annotations[0].failureType][result.predictedFailure]++;
    comparedPairs++;
  }
  const correct = labels.reduce((sum, label) => sum + matrix[label][label], 0);
  return { labels: [...labels], matrix, comparedPairs, excludedPairs: { unreviewed, reviewerDisagreement, invalidPrediction: 0, duplicateResult: 0 }, pipelineAgreement: comparedPairs ? Number((correct / comparedPairs).toFixed(3)) : null };
}
