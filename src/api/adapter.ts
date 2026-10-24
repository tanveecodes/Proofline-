import type {
  DocumentRef,
  EvalResult,
  ProcessingStatus,
  SampleQuestion,
} from "../types";

/**
 * THE INTEGRATION POINT.
 * -----------------------------------------------------------------------
 * This interface is the only surface the UI talks to. The HTTP adapter maps
 * the AI-04 backend contract into these dashboard domain types.
 *
 * If the backend contract changes, update the HTTP mapping here:
 *
 *  1. Preferred: keep this interface, re-shape `src/api/httpAdapter.ts` so its
 *     methods map onto the real endpoints, and map the responses into the types
 *     in `src/types.ts`.
 *  2. If the contract differs structurally, change this interface and the types
 *     together, then fix the two adapters and (if needed) the components.
 *
 * Either way the swap is contained to `src/api/`; components never fetch.
 * -----------------------------------------------------------------------
 */
export interface RagEvalApi {
  /**
   * Upload a document and kick off processing.
   * @param onProgress called with 0..1 upload progress while bytes go up.
   */
  uploadDocument(
    file: File,
    onProgress: (fraction: number) => void,
  ): Promise<DocumentRef>;

  /** Poll processing status until stage === "ready". */
  getProcessingStatus(documentId: string): Promise<ProcessingStatus>;

  /** Suggested questions for the uploaded document. */
  listSampleQuestions(documentId: string): Promise<SampleQuestion[]>;

  /** Run retrieval + generation + the three evaluations. */
  evaluate(payload: {
    documentId: string;
    question: string;
  }): Promise<EvalResult>;
}

export type ApiMode = "sample" | "http";

export interface ApiConfig {
  mode: ApiMode;
  /** Base URL of the AI-04 backend, read from VITE_API_BASE_URL. */
  baseUrl?: string;
}

export function readApiConfig(): ApiConfig {
  const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
  return baseUrl
    ? { mode: "http", baseUrl: baseUrl.replace(/\/$/, "") }
    : { mode: "sample" };
}

/**
 * Returns the sample (mock) adapter when VITE_API_BASE_URL is absent, and the
 * HTTP adapter when it is configured.
 */
export async function createApi(): Promise<RagEvalApi> {
  const config = readApiConfig();
  if (config.mode === "http") {
    const { HttpRagEvalApi } = await import("./httpAdapter");
    return new HttpRagEvalApi(config.baseUrl!);
  }
  const { SampleRagEvalApi } = await import("./sampleAdapter");
  return new SampleRagEvalApi();
}
