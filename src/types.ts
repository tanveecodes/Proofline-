/**
 * Domain types for the RAG evaluation flow.
 *
 * UI domain types. `src/api/httpAdapter.ts` maps backend responses into these
 * shapes, while the sample adapter uses the same types for demo mode.
 */

export type ProcessingStage =
  | "queued"
  | "uploading"
  | "parsing"
  | "chunking"
  | "indexing"
  | "ready"
  | "failed";

export interface ProcessingStatus {
  stage: ProcessingStage;
  /** 0..1 completion of the current stage. */
  progress: number;
  /** Human-readable status line, e.g. "Chunking page 4 of 12". */
  message: string;
}

export interface DocumentRef {
  id: string;
  filename: string;
  pageCount?: number;
  sizeBytes?: number;
}

export interface UploadedDocument extends DocumentRef {
  uploadProgress: number; // 0..1
}

export interface SampleQuestion {
  id: string;
  text: string;
}

/** A single retrieved passage shown in the evidence list. */
export interface EvidenceChunk {
  id: string;
  /** Source file name the chunk came from, as reported by the backend. */
  sourceFilename: string;
  /** 1-based page number, when the backend can attribute it. */
  pageNumber?: number | null;
  text: string;
  /** Similarance score in 0..1 when the backend returns one. */
  retrievalScore?: number | null;
}

export type EvaluationKey = "retrieval" | "support" | "correctness";

export type EvaluationOutcome = "pass" | "fail" | "partial" | "unknown";

export interface Evaluation {
  key: EvaluationKey;
  /** Display label, e.g. "Retrieval". */
  label: string;
  outcome: EvaluationOutcome;
  /** Numeric score in 0..1 when the backend supplies one. */
  score?: number | null;
  /** One-sentence explanation of this individual check. */
  rationale: string;
}

export interface Evaluations {
  retrieval: Evaluation;
  support: Evaluation;
  correctness: Evaluation;
}

/**
 * Overall state of an evaluated answer:
 *  - "supported"   : evidence backs the answer and it matches the reference.
 *  - "unsupported" : retrieval or support failed (the answer is not backed).
 *  - "incorrect"   : the answer contradicts the source / reference.
 *  - "unknown"     : no evaluation was performed (e.g. sample fallback).
 */
export type Verdict = "supported" | "unsupported" | "incorrect" | "unknown";

export interface Diagnosis {
  /** Headline, e.g. "Answer is not backed by the retrieved passages". */
  summary: string;
  /** Plain-language explanation of what went wrong (or why it passed). */
  plainLanguage: string;
  /** Short bullet points the UI lists under the summary. */
  signals: string[];
}

export interface EvalResult {
  question: string;
  answer: string;
  /** Model / pipeline identifier, when the backend reports one. */
  model?: string | null;
  latencyMs?: number | null;
  evidence: EvidenceChunk[];
  evaluations: Evaluations;
  diagnosis: Diagnosis;
  verdict: Verdict;
  /**
   * True while this payload came from the local sample dataset rather than the
   * AI-04 backend. The UI must never present sample data as a real result.
   */
  isSample: boolean;
}
