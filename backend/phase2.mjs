import { randomUUID } from "node:crypto";

export const FAILURE_TYPES = [
  "none",
  "retrieval_miss",
  "wrong_chunk",
  "ignored_context",
  "unsupported_claim",
  "stale_source",
  "incorrect_answer",
];

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function normalizeDataset(input) {
  if (!isRecord(input) || !Array.isArray(input.cases)) {
    throw Object.assign(new Error("Dataset must be a JSON object with a cases array"), { status: 400 });
  }
  if (input.cases.length < 1 || input.cases.length > 200) {
    throw Object.assign(new Error("A Phase 2 dataset must contain between 1 and 200 question-answer pairs"), { status: 400 });
  }
  const ids = new Set();
  const cases = input.cases.map((item, index) => {
    if (!isRecord(item) || typeof item.question !== "string" || !item.question.trim() || item.question.length > 1000) {
      throw Object.assign(new Error(`Case ${index + 1} needs a non-empty question up to 1,000 characters`), { status: 400 });
    }
    if (typeof item.referenceAnswer !== "string" || !item.referenceAnswer.trim() || item.referenceAnswer.length > 10_000) {
      throw Object.assign(new Error(`Case ${index + 1} needs a referenceAnswer up to 10,000 characters`), { status: 400 });
    }
    if (item.id !== undefined && (typeof item.id !== "string" || !item.id.trim() || item.id.trim().length > 100)) {
      throw Object.assign(new Error(`Case ${index + 1} id must be a non-empty string up to 100 characters`), { status: 400 });
    }
    if (item.expectedEvidence !== undefined && (typeof item.expectedEvidence !== "string" || item.expectedEvidence.length > 10_000)) {
      throw Object.assign(new Error(`Case ${index + 1} expectedEvidence must be a string up to 10,000 characters`), { status: 400 });
    }
    if (item.expectedSource !== undefined && (typeof item.expectedSource !== "string" || item.expectedSource.length > 255)) {
      throw Object.assign(new Error(`Case ${index + 1} expectedSource must be a string up to 255 characters`), { status: 400 });
    }
    const id = typeof item.id === "string" ? item.id.trim() : `case-${index + 1}`;
    if (ids.has(id)) throw Object.assign(new Error(`Duplicate case id: ${id}`), { status: 400 });
    ids.add(id);
    return {
      id,
      question: item.question.trim(),
      referenceAnswer: item.referenceAnswer.trim(),
      expectedEvidence: item.expectedEvidence || "",
      expectedSource: item.expectedSource || "",
      annotations: [],
    };
  });
  if (input.name !== undefined && (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 120)) {
    throw Object.assign(new Error("Dataset name must be a non-empty string up to 120 characters"), { status: 400 });
  }
  const name = typeof input.name === "string" ? input.name.trim() : "Imported evaluation set";
  return { id: randomUUID(), name, cases, createdAt: new Date().toISOString() };
}

export function normalizeAnnotation(input) {
  if (!isRecord(input)) throw Object.assign(new Error("Annotation must be an object"), { status: 400 });
  const annotatorId = typeof input.annotatorId === "string" ? input.annotatorId.trim() : "";
  if (!annotatorId || annotatorId.length > 80) throw Object.assign(new Error("Annotator ID is required and must be at most 80 characters"), { status: 400 });
  if (!FAILURE_TYPES.includes(input.failureType)) throw Object.assign(new Error("Choose a valid failure type"), { status: 400 });
  if (typeof input.answerCorrect !== "boolean" || typeof input.evidenceRelevant !== "boolean") {
    throw Object.assign(new Error("Answer correctness and evidence relevance must be Yes or No"), { status: 400 });
  }
  return { annotatorId, failureType: input.failureType, answerCorrect: input.answerCorrect, evidenceRelevant: input.evidenceRelevant, updatedAt: new Date().toISOString() };
}

export function setAnnotation(dataset, caseId, annotation) {
  const item = dataset.cases.find((candidate) => candidate.id === caseId);
  if (!item) throw Object.assign(new Error("Question pair not found in this dataset"), { status: 404 });
  const existing = item.annotations.findIndex((entry) => entry.annotatorId === annotation.annotatorId);
  if (existing < 0 && item.annotations.length >= 2) {
    throw Object.assign(new Error("This pair already has two annotators; use one of their IDs to revise a label"), { status: 409 });
  }
  if (existing < 0) item.annotations.push(annotation);
  else item.annotations[existing] = annotation;
  return dataset;
}

function cohenKappa(pairs, getValue) {
  if (!pairs.length) return null;
  const labels = [...new Set(pairs.flatMap((pair) => [getValue(pair[0]), getValue(pair[1])]))];
  const observed = pairs.filter(([a, b]) => getValue(a) === getValue(b)).length / pairs.length;
  const expected = labels.reduce((sum, label) => {
    const first = pairs.filter(([a]) => getValue(a) === label).length / pairs.length;
    const second = pairs.filter(([, b]) => getValue(b) === label).length / pairs.length;
    return sum + first * second;
  }, 0);
  return expected === 1 ? (observed === 1 ? 1 : 0) : Number(((observed - expected) / (1 - expected)).toFixed(3));
}

export function annotationReport(dataset) {
  const complete = dataset.cases.filter((item) => item.annotations.length === 2);
  const typeAgreement = complete.filter((item) => item.annotations[0].failureType === item.annotations[1].failureType).length;
  const correctnessAgreement = complete.filter((item) => item.annotations[0].answerCorrect === item.annotations[1].answerCorrect).length;
  const evidenceAgreement = complete.filter((item) => item.annotations[0].evidenceRelevant === item.annotations[1].evidenceRelevant).length;
  const fullAgreementCount = complete.filter((item) =>
    item.annotations[0].failureType === item.annotations[1].failureType &&
    item.annotations[0].answerCorrect === item.annotations[1].answerCorrect &&
    item.annotations[0].evidenceRelevant === item.annotations[1].evidenceRelevant
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

export function consensusFailure(item) {
  if (item.annotations.length !== 2 || item.annotations[0].failureType !== item.annotations[1].failureType) return null;
  return item.annotations[0].failureType;
}

export function predictFailure(item, result) {
  if (!item || !result || !Array.isArray(result.retrievedEvidence) || !result.scores) return null;
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
  if ((result.scores.support ?? 1) < 0.45) {
    return "unsupported_claim";
  }
  if (result.scores.correctness != null && result.scores.correctness < 0.5) {
    return expectedEvidenceFound ? "ignored_context" : "incorrect_answer";
  }
  return "none";
}

export function confusionMatrix(results, cases) {
  const labels = FAILURE_TYPES;
  const matrix = Object.fromEntries(labels.map((gold) => [gold, Object.fromEntries(labels.map((predicted) => [predicted, 0]))]));
  const caseById = new Map(cases.map((item) => [item.id, item]));
  let aligned = 0; let excludedUnreviewed = 0; let excludedDisagreement = 0; let excludedInvalidPrediction = 0; let excludedDuplicateResult = 0;
  const resultsById = new Map();
  for (const result of results) {
    if (!result || typeof result.caseId !== "string") { excludedInvalidPrediction += 1; continue; }
    const grouped = resultsById.get(result.caseId) || [];
    grouped.push(result);
    resultsById.set(result.caseId, grouped);
  }
  for (const [caseId, grouped] of resultsById) {
    if (grouped.length !== 1) { excludedDuplicateResult += grouped.length; continue; }
    const item = caseById.get(caseId);
    if (!item || !Array.isArray(item.annotations) || item.annotations.length < 2) { excludedUnreviewed += 1; continue; }
    const gold = consensusFailure(item);
    if (gold == null) { excludedDisagreement += 1; continue; }
    const predicted = grouped[0].predictedFailure;
    if (!labels.includes(gold) || !labels.includes(predicted)) { excludedInvalidPrediction += 1; continue; }
    matrix[gold][predicted] += 1;
    aligned += gold === predicted ? 1 : 0;
  }
  const count = Object.values(matrix).reduce((sum, row) => sum + Object.values(row).reduce((a, b) => a + b, 0), 0);
  return {
    labels, matrix, comparedPairs: count,
    excludedPairs: { unreviewed: excludedUnreviewed, reviewerDisagreement: excludedDisagreement, invalidPrediction: excludedInvalidPrediction, duplicateResult: excludedDuplicateResult },
    pipelineAgreement: count ? Number((aligned / count).toFixed(3)) : null,
  };
}

export async function mapLimit(items, limit, callback) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await callback(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
