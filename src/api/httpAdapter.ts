import type { RagEvalApi } from "./adapter";
import type {
  DocumentRef,
  EvalResult,
  Evaluation,
  EvaluationKey,
  EvaluationOutcome,
  ProcessingStatus,
  SampleQuestion,
} from "../types";

interface ApiEvaluation {
  question: string;
  answer: string;
  retrievedEvidence: Array<{ text: string; source: string; page: number | null; retrievalScore?: number }>;
  scores: { retrieval: number | null; support: number | null; correctness: number | null };
  diagnosis: string;
  supportRationale?: string;
  correctnessRationale?: string;
  status: "supported" | "unsupported" | "incorrect" | "unknown";
  model?: string;
  latencyMs?: number;
  knownAnswer?: string | null;
  aiWarning?: string | null;
}

function scoreOutcome(score: number | null | undefined): EvaluationOutcome {
  if (score == null) return "unknown";
  if (score >= 0.7) return "pass";
  if (score >= 0.4) return "partial";
  return "fail";
}

function evaluation(key: EvaluationKey, label: string, score: number | null, rationale: string): Evaluation {
  return { key, label, outcome: scoreOutcome(score), score, rationale };
}

function mapResult(result: ApiEvaluation): EvalResult {
  const evaluations = {
    retrieval: evaluation("retrieval", "Retrieval", result.scores.retrieval, "Lexical overlap between the question or known answer and retrieved passages."),
    support: evaluation("support", "Support", result.scores.support, result.supportRationale || result.diagnosis),
    correctness: evaluation("correctness", "Correctness", result.scores.correctness, result.correctnessRationale || (result.knownAnswer ? result.diagnosis : "No known answer is configured for this question.")),
  };
  const verdict = result.status === "supported" || result.status === "unsupported" || result.status === "incorrect" ? result.status : "unknown";
  return {
    question: result.question,
    answer: result.answer,
    model: result.model || null,
    latencyMs: result.latencyMs ?? null,
    evidence: result.retrievedEvidence.map((item, index) => ({
      id: `${index}-${item.source}-${item.page ?? "na"}`,
      sourceFilename: item.source,
      pageNumber: item.page,
      text: item.text,
      retrievalScore: item.retrievalScore ?? null,
    })),
    evaluations,
    diagnosis: {
      summary: verdict === "supported" ? "Answer is supported by retrieved evidence" : verdict === "incorrect" ? "Answer does not match the known answer" : verdict === "unsupported" ? "The relevant passage was not retrieved or the answer is unsupported" : "Evaluation is inconclusive",
      plainLanguage: result.diagnosis,
      signals: [result.aiWarning, evaluations.retrieval.rationale, evaluations.support.rationale, evaluations.correctness.rationale].filter((signal): signal is string => Boolean(signal)),
    },
    verdict,
    isSample: false,
  };
}

export class HttpRagEvalApi implements RagEvalApi {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(125_000) });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new Error("The backend took too long to respond. Check the backend and local model, then retry.");
      }
      throw new Error("Could not reach the backend. Check that it is running and retry.");
    }
    const body = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new Error(body.error || `Backend request failed (${response.status})`);
    return body;
  }

  uploadDocument(file: File, onProgress: (fraction: number) => void): Promise<DocumentRef> {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append("file", file);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${this.baseUrl}/documents`);
      xhr.timeout = 60_000;
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        reject(new Error(message));
      };
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      };
      xhr.onerror = () => fail("Could not reach the backend. Check that it is running.");
      xhr.ontimeout = () => fail("Document processing took too long. Try a smaller file or check the PDF/DOCX tools.");
      xhr.onabort = () => fail("Document upload was cancelled.");
      xhr.onload = () => {
        let body: DocumentRef & { error?: string };
        try { body = JSON.parse(xhr.responseText || "{}"); }
        catch { fail("The backend returned an unreadable upload response. Check its terminal for errors."); return; }
        if (xhr.status < 200 || xhr.status >= 300) { fail(body.error || `Upload failed (${xhr.status})`); return; }
        if (settled) return;
        settled = true;
        onProgress(1);
        resolve(body);
      };
      xhr.send(form);
    });
  }

  getProcessingStatus(documentId: string): Promise<ProcessingStatus> {
    return this.request(`/documents/${encodeURIComponent(documentId)}`);
  }

  listSampleQuestions(documentId: string): Promise<SampleQuestion[]> {
    return this.request(`/documents/${encodeURIComponent(documentId)}/questions`);
  }

  async evaluate(payload: { documentId: string; question: string }): Promise<EvalResult> {
    const result = await this.request<ApiEvaluation>("/evaluate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return mapResult(result);
  }
}
