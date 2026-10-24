import test from "node:test";
import assert from "node:assert/strict";
import {
  FAILURE_TYPES,
  annotationReport,
  confusionMatrix,
  mapLimit,
  normalizeAnnotation,
  normalizeDataset,
  predictFailure,
  setAnnotation,
} from "./phase2.mjs";

function label(failureType, annotatorId) {
  return normalizeAnnotation({ annotatorId, failureType, answerCorrect: failureType === "none", evidenceRelevant: failureType !== "retrieval_miss" });
}

test("dataset import requires real references and discards incoming annotation claims", () => {
  const dataset = normalizeDataset({ cases: [{ id: "a", question: "Question?", referenceAnswer: "Known answer", annotations: [{ annotatorId: "made-up" }] }] });
  assert.equal(dataset.cases[0].annotations.length, 0);
  assert.throws(() => normalizeDataset({ cases: [{ question: " ", referenceAnswer: "Answer" }] }), /non-empty question/);
  assert.throws(() => normalizeDataset({ cases: [{ question: "Q", referenceAnswer: "A" }, { question: "Q2", referenceAnswer: "A", id: "case-2" }, { question: "Q3", referenceAnswer: "A", id: "case-2" }] }), /Duplicate case id/);
});

test("annotation workflow enforces two distinct reviewers and computes agreement", () => {
  const dataset = normalizeDataset({ cases: [{ id: "a", question: "Question?", referenceAnswer: "Known answer" }] });
  setAnnotation(dataset, "a", label("incorrect_answer", "alice"));
  setAnnotation(dataset, "a", label("incorrect_answer", "alice")); // Reviewer may revise their own label.
  setAnnotation(dataset, "a", label("incorrect_answer", "bob"));
  assert.throws(() => setAnnotation(dataset, "a", label("none", "charlie")), /already has two annotators/);
  const report = annotationReport(dataset);
  assert.equal(report.doubleLabeled, 1);
  assert.equal(report.fullAgreementCount, 1);
  assert.equal(report.failureTypeAgreement, 1);
  assert.equal(report.failureTypeCohenKappa, 1);
});

test("150-pair human review progress only counts pairs with full reviewer agreement", () => {
  const dataset = normalizeDataset({ cases: [
    { id: "agreed", question: "Question 1?", referenceAnswer: "Answer 1" },
    { id: "split", question: "Question 2?", referenceAnswer: "Answer 2" },
  ] });
  setAnnotation(dataset, "agreed", label("none", "reviewer-a"));
  setAnnotation(dataset, "agreed", label("none", "reviewer-b"));
  setAnnotation(dataset, "split", label("none", "reviewer-a"));
  setAnnotation(dataset, "split", normalizeAnnotation({ annotatorId: "reviewer-b", failureType: "none", answerCorrect: false, evidenceRelevant: true }));
  const report = annotationReport(dataset);
  assert.equal(report.doubleLabeled, 2);
  assert.equal(report.fullAgreementCount, 1);
  assert.equal(report.target150Progress, 1);
});

test("failure classification covers six named categories from explicit evidence signals", () => {
  const base = { expectedEvidence: "refund within thirty days delivery", expectedSource: "policy.pdf" };
  const result = (retrievedEvidence, support, correctness, retrieval = 0.8) => ({ retrievedEvidence, scores: { retrieval, support, correctness } });
  const good = [{ text: "Refunds are available within thirty days of delivery.", source: "policy.pdf" }];
  assert.equal(predictFailure(base, result([], 0, 0, 0)), "retrieval_miss");
  assert.equal(predictFailure(base, result([{ text: "Something unrelated", source: "policy.pdf" }], 0.8, 0.2)), "wrong_chunk");
  assert.equal(predictFailure(base, result([{ text: "Refunds are available within thirty days of delivery.", source: "policy.pdf" }], 0.8, 0.2)), "ignored_context");
  assert.equal(predictFailure({ ...base, expectedSource: "other.pdf" }, result(good, 0.2, 0.1)), "stale_source");
  assert.equal(predictFailure(base, result(good, 0.2, 0.8)), "unsupported_claim");
  assert.equal(predictFailure({ ...base, expectedEvidence: "", expectedSource: "" }, result(good, 0.2, 0.2, 0.1)), "unsupported_claim");
  assert.equal(predictFailure({ ...base, expectedEvidence: "", expectedSource: "" }, result(good, 0.8, 0.1, 0.8)), "incorrect_answer");
  assert.equal(predictFailure(base, result(good, 0.8, 0.8)), "none");
});

test("confusion matrix is invariant to result order and excludes non-consensus labels", () => {
  const cases = ["a", "b", "c"].map((id) => ({ id, annotations: [] }));
  cases[0].annotations = [label("none", "a1"), label("none", "a2")];
  cases[1].annotations = [label("wrong_chunk", "b1"), label("wrong_chunk", "b2")];
  cases[2].annotations = [label("none", "c1"), label("incorrect_answer", "c2")];
  const results = [
    { caseId: "a", predictedFailure: "none" },
    { caseId: "b", predictedFailure: "retrieval_miss" },
    { caseId: "c", predictedFailure: "none" },
    { caseId: "a", predictedFailure: "incorrect_answer" },
  ];
  const first = confusionMatrix(results, cases);
  const shuffled = confusionMatrix([...results].reverse(), cases);
  assert.deepEqual(shuffled, first);
  assert.equal(first.comparedPairs, 1);
  assert.equal(first.excludedPairs.reviewerDisagreement, 1);
  assert.equal(first.excludedPairs.duplicateResult, 2);
  assert.equal(first.pipelineAgreement, 0);
  assert.deepEqual(FAILURE_TYPES, first.labels);
});

test("bounded concurrency preserves input-to-output alignment", async () => {
  const input = ["case-a", "case-b", "case-c"];
  const output = await mapLimit(input, 2, async (value) => {
    await new Promise((resolve) => setTimeout(resolve, value === "case-a" ? 10 : 1));
    return { caseId: value };
  });
  assert.deepEqual(output.map((row) => row.caseId), input);
});

