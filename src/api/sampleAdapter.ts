/**
 * SAMPLE (MOCK) ADAPTER — DEVELOPMENT ONLY.
 *
 * Implements `RagEvalApi` against local canned data so the UI can be built and
 * demoed before the AI-04 backend contract exists. It simulates upload
 * progress, processing stages and evaluation latency. No network calls happen.
 *
 * This file is selected by `createApi()` in adapter.ts whenever
 * `VITE_API_BASE_URL` is unset. Delete it once the real backend is wired.
 */
import type { RagEvalApi } from "./adapter";
import type {
  DocumentRef,
  EvalResult,
  ProcessingStatus,
  SampleQuestion,
} from "../types";
import {
  SAMPLE_DOCUMENT,
  SAMPLE_PROCESSING_STAGES,
  SAMPLE_QUESTIONS,
  SAMPLE_RESULT_GENERIC,
  SAMPLE_RESULT_INCORRECT,
  SAMPLE_RESULT_SUPPORTED,
  SAMPLE_RESULT_SUPPORTED_BILLING,
  SAMPLE_RESULT_UNSUPPORTED,
} from "./sampleData";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function pickResult(question: string): EvalResult {
  const q = question.toLowerCase();
  if (q.includes("shipping") || q.includes("express") || q.includes("cost to")) {
    return SAMPLE_RESULT_UNSUPPORTED;
  }
  if (q.includes("accidental") || q.includes("damage") || q.includes("cover")) {
    return SAMPLE_RESULT_INCORRECT;
  }
  if (q.includes("refund")) {
    return SAMPLE_RESULT_SUPPORTED;
  }
  if (q.includes("bill") || q.includes("subscri")) {
    return SAMPLE_RESULT_SUPPORTED_BILLING;
  }
  return SAMPLE_RESULT_GENERIC(question);
}

export class SampleRagEvalApi implements RagEvalApi {
  private stageIndex = 0;

  async uploadDocument(
    file: File,
    onProgress: (fraction: number) => void,
  ): Promise<DocumentRef> {
    // Simulated byte-level upload.
    for (let fraction = 0.2; fraction <= 1; fraction += 0.2) {
      onProgress(Math.min(fraction, 1));
      await wait(220);
    }
    this.stageIndex = 0;
    return {
      ...SAMPLE_DOCUMENT,
      filename: file.name,
      sizeBytes: file.size,
    };
  }

  async getProcessingStatus(_documentId: string): Promise<ProcessingStatus> {
    const step = SAMPLE_PROCESSING_STAGES[this.stageIndex];
    if (!step) {
      return { stage: "ready", progress: 1, message: "Document ready" };
    }
    this.stageIndex += 1;
    // Keep uploading mapped onto the upload phase for the progress bar.
    return {
      stage: step.stage,
      progress: step.progress,
      message: step.message,
    };
  }

  async listSampleQuestions(_documentId: string): Promise<SampleQuestion[]> {
    return SAMPLE_QUESTIONS;
  }

  async evaluate(payload: { documentId: string; question: string }): Promise<EvalResult> {
    // Simulated end-to-end pipeline latency.
    await wait(1200);
    const result = pickResult(payload.question);
    return { ...result, question: payload.question };
  }
}
