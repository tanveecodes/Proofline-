/**
 * SAMPLE DATA — NOT REAL RESULTS.
 *
 * This module exists so the UI can be developed and demoed before the AI-04
 * backend contract is available. Every payload derived from it is flagged with
 * `isSample: true`, and the UI renders a persistent banner so nobody mistakes
 * it for a measured result.
 *
 * Delete this file once the real backend is wired through `httpAdapter.ts`.
 */
import type {
  Diagnosis,
  DocumentRef,
  Evaluation,
  Evaluations,
  EvalResult,
  EvidenceChunk,
  SampleQuestion,
  Verdict,
} from "../types";

export const SAMPLE_DOCUMENT: DocumentRef = {
  id: "sample-doc-001",
  filename: "sample-corpus.pdf",
  pageCount: 6,
  sizeBytes: 184_320,
};

/**
 * Four canned questions: two that resolve to the supported state, one to the
 * unsupported state and one to the incorrect state, so every verdict can be
 * demonstrated without a backend.
 */
export const SAMPLE_QUESTIONS: SampleQuestion[] = [
  { id: "q-refund", text: "How long does a customer have to request a refund?" },
  { id: "q-shipping", text: "What is the express shipping cost to Canada?" },
  { id: "q-coverage", text: "Does the policy cover accidental damage?" },
  { id: "q-billing", text: "When is the annual subscription billed?" },
];

const ok = (key: Evaluation["key"], label: string, rationale: string): Evaluation => ({
  key,
  label,
  outcome: "pass",
  score: 0.9,
  rationale,
});

const fail = (
  key: Evaluation["key"],
  label: string,
  score: number | null,
  rationale: string,
): Evaluation => ({ key, label, outcome: "fail", score, rationale });

/**
 * Classifies a run into the three user-facing states:
 *  - retrieval AND support both weak  -> "unsupported": the answer leans on
 *    claims no passage backs, because the right context never came back.
 *  - retrieval strong but support/correctness fail -> "incorrect": the model
 *    contradicted context it was actually given (a generation failure).
 *  - otherwise                        -> "supported".
 */
function verdictOf(evals: Evaluations): Verdict {
  const outcomes = [evals.retrieval.outcome, evals.support.outcome, evals.correctness.outcome];
  if (outcomes.includes("unknown")) return "unknown";

  const retrievalSolid = evals.retrieval.outcome === "pass";
  const supportSolid = evals.support.outcome === "pass";

  if (!supportSolid && !retrievalSolid) return "unsupported";
  if (!supportSolid || evals.correctness.outcome === "fail") return "incorrect";
  return "supported";
}

function buildResult(input: {
  question: string;
  answer: string;
  evidence: EvidenceChunk[];
  evaluations: Evaluations;
  diagnosis: Diagnosis;
}): EvalResult {
  return {
    question: input.question,
    answer: input.answer,
    model: "sample-eval-model",
    latencyMs: 1240,
    evidence: input.evidence,
    evaluations: input.evaluations,
    diagnosis: input.diagnosis,
    verdict: verdictOf(input.evaluations),
    isSample: true,
  };
}

const chunk = (
  id: string,
  pageNumber: number | null,
  text: string,
  retrievalScore: number,
): EvidenceChunk => ({
  id,
  sourceFilename: SAMPLE_DOCUMENT.filename,
  pageNumber,
  text,
  retrievalScore,
});

/** Retrieval good, everything supported — the "healthy" path. */
export const SAMPLE_RESULT_SUPPORTED: EvalResult = buildResult({
  question: SAMPLE_QUESTIONS[0].text,
  answer:
    "Customers have 30 days from the delivery date to request a refund. Requests after 30 days are reviewed case by case.",
  evidence: [
    chunk(
      "ev-1",
      2,
      "A customer may request a refund within 30 days of the delivery date. The request must include the order number.",
      0.87,
    ),
    chunk(
      "ev-2",
      3,
      "Refund requests received after the 30-day window are escalated for a manual review and are not guaranteed.",
      0.74,
    ),
  ],
  evaluations: {
    retrieval: ok(
      "retrieval",
      "Retrieval",
      "The passages returned contain the refund window directly.",
    ),
    support: ok(
      "support",
      "Support",
      "Every claim in the answer is backed by a retrieved passage.",
    ),
    correctness: ok(
      "correctness",
      "Correctness",
      "The answer matches the reference answer for this question.",
    ),
  },
  diagnosis: {
    summary: "Answer is supported by the retrieved evidence",
    plainLanguage:
      "The search returned the right passages, the answer only repeats what those passages say, and it agrees with the reference answer. Nothing to fix here.",
    signals: [
      "Top passage scores are above the acceptance threshold.",
      "No claim in the answer is missing from the evidence.",
      "Answer and reference agree.",
    ],
  },
});

/** Second supported path so more than one question resolves as healthy. */
export const SAMPLE_RESULT_SUPPORTED_BILLING: EvalResult = buildResult({
  question: SAMPLE_QUESTIONS[3].text,
  answer:
    "The annual subscription is billed once per year on the anniversary of the initial purchase date.",
  evidence: [
    chunk(
      "ev-8",
      5,
      "Annual subscriptions are billed once a year on the anniversary of the date the subscription started.",
      0.91,
    ),
  ],
  evaluations: {
    retrieval: ok("retrieval", "Retrieval", "The billing clause was retrieved."),
    support: ok("support", "Support", "The answer is fully backed by the passage."),
    correctness: ok("correctness", "Correctness", "The answer matches the reference answer."),
  },
  diagnosis: {
    summary: "Answer is supported by the retrieved evidence",
    plainLanguage:
      "The right passage was found, the answer only restates it, and it agrees with the reference. No fix needed.",
    signals: [
      "Best passage clears the retrieval threshold.",
      "No unsupported claims in the answer.",
      "Answer and reference agree.",
    ],
  },
});

/** Retrieval found something, but the answer invents a figure. */
export const SAMPLE_RESULT_UNSUPPORTED: EvalResult = buildResult({
  question: SAMPLE_QUESTIONS[1].text,
  answer: "Express shipping to Canada costs $12.99 and arrives in 2 business days.",
  evidence: [
    chunk(
      "ev-3",
      4,
      "Standard shipping to Canada is available. Express options are listed at checkout and vary by destination.",
      0.61,
    ),
    chunk(
      "ev-4",
      5,
      "Shipping rates are calculated by weight and zone at the time of checkout.",
      0.48,
    ),
  ],
  evaluations: {
    retrieval: {
      key: "retrieval",
      label: "Retrieval",
      outcome: "partial",
      score: 0.55,
      rationale:
        "Passages are about shipping to Canada but never state an express price.",
    },
    support: fail(
      "support",
      "Support",
      0.2,
      "The figure $12.99 does not appear in any retrieved passage.",
    ),
    correctness: fail(
      "correctness",
      "Correctness",
      0.15,
      "The reference answer states that the price is not published in this document.",
    ),
  },
  diagnosis: {
    summary: "The answer is not supported by the evidence",
    plainLanguage:
      "The system found passages about shipping, but none of them mention a price for express delivery to Canada. The model supplied the $12.99 figure on its own, so the answer looks confident while being unsupported. Retrieval is the first thing to improve: the passage that would answer this may not be in the index.",
    signals: [
      "Support check failed: the key figure is absent from the evidence.",
      "Retrieval score on the best passage is below the acceptance threshold.",
      "Answer introduces a claim no passage contains.",
    ],
  },
});

/** Retrieval fine, but the answer contradicts the source. */
export const SAMPLE_RESULT_INCORRECT: EvalResult = buildResult({
  question: SAMPLE_QUESTIONS[2].text,
  answer: "Yes — accidental damage is fully covered under the standard policy.",
  evidence: [
    chunk(
      "ev-5",
      3,
      "The standard policy covers manufacturing defects for 12 months.",
      0.83,
    ),
    chunk(
      "ev-6",
      3,
      "Accidental damage is excluded from the standard policy and requires the optional protection add-on.",
      0.79,
    ),
  ],
  evaluations: {
    retrieval: ok(
      "retrieval",
      "Retrieval",
      "The relevant coverage clause was retrieved.",
    ),
    support: fail(
      "support",
      "Support",
      0.35,
      "The retrieved clause excludes accidental damage; the answer claims the opposite.",
    ),
    correctness: fail(
      "correctness",
      "Correctness",
      0.1,
      "The answer contradicts the reference answer.",
    ),
  },
  diagnosis: {
    summary: "The answer contradicts the source document",
    plainLanguage:
      "Search worked — the exact clause was found — but the answer says the opposite of what that clause says. This is a generation problem rather than a retrieval problem: the model ignored the passage it was given.",
    signals: [
      "Retrieval passed: the correct passage was in the context.",
      "Support failed: the answer reverses the meaning of the passage.",
      "Correctness failed: reference says accidental damage is excluded.",
    ],
  },
});

/** Fallback for a question the canned dataset does not cover. */
export const SAMPLE_RESULT_GENERIC = (question: string): EvalResult =>
  buildResult({
    question,
    answer:
      "This sample result was generated locally so the interface can be explored. No backend call was made.",
    evidence: [
      chunk(
        "ev-7",
        1,
        "Placeholder passage used while the AI-04 backend contract is being finalised.",
        0.42,
      ),
    ],
    evaluations: {
      retrieval: {
        key: "retrieval",
        label: "Retrieval",
        outcome: "unknown",
        score: null,
        rationale: "Sample adapter: no real retrieval was performed.",
      },
      support: {
        key: "support",
        label: "Support",
        outcome: "unknown",
        score: null,
        rationale: "Sample adapter: no real support check was performed.",
      },
      correctness: {
        key: "correctness",
        label: "Correctness",
        outcome: "unknown",
        score: null,
        rationale: "Sample adapter: no real correctness check was performed.",
      },
    },
    diagnosis: {
      summary: "Sample data — no evaluation was run",
      plainLanguage:
        "This question is not part of the sample dataset, so no evaluations exist for it. Connect the AI-04 backend to evaluate real questions.",
      signals: [
        "The AI-04 backend is not connected.",
        "Sample questions above produce sample pass / fail / incorrect outcomes.",
      ],
    },
  });

export const SAMPLE_PROCESSING_STAGES = [
  { stage: "uploading", progress: 0.35, message: "Uploading document" },
  { stage: "parsing", progress: 0.5, message: "Extracting text and page boundaries" },
  { stage: "chunking", progress: 0.7, message: "Splitting text into passages" },
  { stage: "indexing", progress: 0.9, message: "Building the retrieval index" },
  { stage: "ready", progress: 1, message: "Document ready" },
] as const;