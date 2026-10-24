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
  constructor(private readonly baseUrl: string) {}

  private async request<T>(path: string, body?: unknown): Promise<T> {
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

  listDocuments() { return this.request<Phase2Document[]>("/documents"); }
  listDatasets(documentId?: string) {
    const query = documentId ? `?documentId=${encodeURIComponent(documentId)}` : "";
    return this.request<Phase2DatasetSummary[]>(`/phase2/datasets${query}`);
  }
  getDataset(id: string) { return this.request<Phase2Dataset>(`/phase2/datasets/${encodeURIComponent(id)}`); }
  createDataset(payload: unknown) { return this.request<Phase2Dataset>("/phase2/datasets", payload); }
  generateDataset(documentId: string, count: number) {
    return this.request<Phase2GenerationJob>("/phase2/generate-dataset", { documentId, count });
  }
  getGenerationJob(id: string) { return this.request<Phase2GenerationJob>(`/phase2/generation-jobs/${encodeURIComponent(id)}`); }
  saveAnnotation(datasetId: string, caseId: string, annotation: Omit<Phase2Annotation, "updatedAt">) {
    return this.request<Phase2Dataset>(`/phase2/datasets/${encodeURIComponent(datasetId)}/annotations`, { caseId, annotation });
  }
  runBenchmark(documentId: string, datasetId: string, answers?: Array<{ caseId: string; answer: string }>) {
    return this.request<BenchmarkReport>("/phase2/benchmark", { documentId, datasetId, ...(answers ? { answers } : {}) });
  }
  compare(input: { baselineDocumentId: string; candidateDocumentId: string; datasetId: string; baselineConfig: { topK: number; minScore: number }; candidateConfig: { topK: number; minScore: number }; baselineLabel?: string; candidateLabel?: string }) {
    return this.request<CompareReport>("/phase2/compare", input);
  }
}
