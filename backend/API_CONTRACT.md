# AI-04 backend API contract

Base URL: `http://localhost:8000/api` (override with `PORT`). JSON responses use UTF-8. Upload uses multipart form data. Errors use `{ "error": "plain-language message" }`.

This is the agreed integration proposal for the frontend seam in `src/api/adapter.ts`. It preserves its upload → status → question list → evaluate flow. Backend-owned files are confined to `backend/`; the React UI and `src/api/` remain frontend-owned.

## Endpoints

### `POST /documents`

Send `multipart/form-data` with a `file` field. Supported formats: `.pdf`, `.docx`, `.txt`, `.md`; maximum 15 MiB. Returns `201` after extraction and indexing finish.

```json
{
  "id": "c2d...",
  "filename": "policy.pdf",
  "sizeBytes": 82014,
  "pageCount": 6,
  "status": "ready"
}
```

`pageCount` is `null` when the format does not provide pages.

### `GET /documents/{documentId}`

Returns `{ "id", "filename", "status", "stage", "progress", "message", "pageCount" }`. Processing is synchronous in this MVP, so a successful upload is immediately `ready` with progress `1`.

### `GET /documents/{documentId}/questions`

Returns an array of known questions detected in the uploaded text:

```json
[{ "id": "q-refund", "text": "How long does a customer have to request a refund?" }]
```

The known answers are small fixtures aligned with `backend/sample-corpus.txt` and the current UI's sample question wording. They are not generated automatically.

### `POST /evaluate` (alias: `POST /evaluations`)

For one question, send `{ "documentId": "...", "question": "..." }`; response is one result. For a set, send `{ "documentId": "...", "questions": ["...", "..."] }`; response is `{ "results": [...] }`. Batch requests accept 1–5 non-empty questions, each at most 1,000 characters. Individual questions are limited to 1,000 characters.

Each result contains `question`, `answer`, `retrievedEvidence` (`text`, `source`, `page`, optional `retrievalScore`), `scores` (`retrieval`, `support`, `correctness`), `diagnosis`, `status`, `knownAnswer`, `model`, `latencyMs`, and `scoringNote`. Retrieval is a lexical-overlap heuristic. With `AI_PROVIDER=openai`, GPT-6 Astra generates the answer from retrieved text and separately judges support and known-answer correctness. With `AI_PROVIDER=gemini`, the configured Gemini model uses the OpenAI-compatible Chat Completions endpoint for the same two steps. With `AI_PROVIDER=ollama`, the backend uses a local Ollama model via its OpenAI-compatible API at `http://localhost:11434/v1`; no API key is sent. Set `AI_PROVIDER=extractive` for a no-model mode: it returns an extractive answer and lexical scores without making external model calls. If a selected model API is unavailable, the backend falls back and returns an `aiWarning`. Correctness is `null` without a matching known-answer fixture. None of these scores are validated benchmark measurements.


## Phase 2 extension

Phase 2 adds a local human-labeling workflow, deterministic evaluator benchmark, and same-question RAG configuration comparison. It deliberately does not fabricate human labels or automatically generate a 150-pair dataset. The team must supply its real question/reference-answer pairs and collect two distinct reviewer labels per pair. Import JSON using [phase2-dataset-template.json](phase2-dataset-template.json); accepted datasets contain 1–200 cases. The UI shows progress toward 150 fully double-labeled cases. Imported annotation claims are discarded; only labels saved through the review workflow count.

Each case requires `id` (optional), `question`, and `referenceAnswer`; `expectedEvidence` and `expectedSource` are optional. Reviewers separately label failure type, answer correctness, and evidence relevance. Failure categories are `retrieval_miss`, `wrong_chunk`, `ignored_context`, `unsupported_claim`, `stale_source`, and `incorrect_answer`, plus `none`. The report computes raw agreement, Cohen's kappa for failure type, correctness/evidence agreement, and a pipeline-vs-human confusion matrix. The 150-pair progress counts pairs where both reviewers agree on all three labels; the confusion matrix separately uses consensus on failure type. Unreviewed cases, reviewer disagreements, and invalid rows are counted as excluded rather than treated as agreement or as the `none` class.

### `GET /documents`

Lists locally stored document IDs and filenames so the same uploaded source versions can be selected for benchmarking and comparison.

### `POST /phase2/datasets` / `GET /phase2/datasets` / `GET /phase2/datasets/{datasetId}`

Import, list, or retrieve a dataset. `POST` accepts `{ "name": "...", "cases": [...] }`. Imported rows begin unannotated. Dataset JSON is stored locally under `backend/data/`.

### `POST /phase2/generate-dataset`

Body: `{ "documentId": "...", "count": 150 }` (`count` must be 110–200; defaults to 150). Starts a background job and immediately returns HTTP 202 with a job ID, progress, and requested count. It calls the configured local Ollama model only; if `AI_PROVIDER=ollama` and the model are unavailable, the job fails with an explanatory error and never falls back to a paid provider. Llama generates the question and concise answer; the backend attaches a sentence from that same source page only when its terms support the answer. Each pair records source filename and page when available. Every pair starts without reviewer annotations and metadata marks `humanReviewed: false`.

Poll `GET /phase2/generation-jobs/{jobId}` for `queued`, `running`, `complete`, `partial`, or `failed` status, batch progress, actual generated count, and dataset ID. On completion retrieve the set from `GET /phase2/datasets/{datasetId}`. Uploading a new source from the workbench starts a 150-pair generation job automatically. Candidates are not human labels; two reviewers must still review them for checkpoint 1. The same fixed dataset/case IDs can be reused for checkpoint 4 comparisons and order-stability checks.

### `POST /phase2/datasets/{datasetId}/annotations`

Body: `{ "caseId": "case-001", "annotation": { "annotatorId": "reviewer-1", "failureType": "wrong_chunk", "answerCorrect": false, "evidenceRelevant": false } }`. Each pair accepts at most two distinct annotator IDs; a reviewer can revise their own label.

### `POST /phase2/benchmark`

Body: `{ "datasetId": "...", "documentId": "..." }`. By default, this measures the built-in extractive baseline; that does not count as evaluating another system's generated answer. To evaluate actual outputs from a RAG system, include `answers`: an array containing exactly one `{ "caseId": "...", "answer": "..." }` row for every dataset case. Rows are aligned by `caseId`, never array position; duplicate, missing, unknown, or empty answers are rejected. Retrieval still uses the question only. It returns each output, retrieved evidence, per-question diagnosis, aggregate scores, annotation agreement, the failure-type confusion matrix, and measured questions per minute. Answer support and correctness checks use deterministic lexical overlap; they are not a language-understanding judge and do not call a model. It reports throughput; it does not guarantee a machine will meet 15 minutes until measured on the team's real 200-case set.

### `POST /phase2/compare`

Body: `{ "datasetId": "...", "baselineDocumentId": "...", "candidateDocumentId": "...", "baselineConfig": { "topK": 3, "minScore": 0.01 }, "candidateConfig": { "topK": 5, "minScore": 0.05 } }`. It runs the same case IDs/questions against each document and retrieval configuration. `topK` must be 1–10; `minScore` must be 0–1. You may use the same document if the retrieval settings differ. Each configuration is echoed in the response. A regression is a score decrease of at least 0.10 or a status change from supported to non-supported. The response includes aggregate scores, per-case regression signals, and duration. This compares retriever/index settings using the same deterministic extractive answerer; it does not compare arbitrary external RAG implementations or generation models.

Retrieval in both Phase 1 and Phase 2 is query-only: known reference answers are never used to select evidence. Phase 2 scoring and failure classifications are transparent lexical heuristics for a demo, not scientifically validated metrics. For meaningful generator results, provide the actual system answers with the benchmark request. Dataset persistence is local to this backend instance.

## Example evaluation response

```json
{
  "question": "How long does a customer have to request a refund?",
  "answer": "A customer may request a refund within 30 days of the delivery date.",
  "retrievedEvidence": [
    {
      "text": "Refunds: A customer may request a refund within 30 days of the delivery date. The request must include the order number.",
      "source": "sample-corpus.txt",
      "page": null,
      "retrievalScore": 0.5
    }
  ],
  "scores": { "retrieval": 0.75, "support": 1, "correctness": 0.75 },
  "diagnosis": "The answer is supported by the retrieved text and agrees with the known answer.",
  "status": "supported",
  "knownAnswer": "A customer may request a refund within 30 days of the delivery date. Requests after that are reviewed case by case.",
  "scoringNote": "Heuristic lexical overlap (0–1), intended for a transparent demo, not a validated scientific metric."
}
```

## Frontend mapping

The frontend can map `retrievedEvidence` to its `evidence` shape (`sourceFilename` ← `source`, `pageNumber` ← `page`) and `scores` into its evaluation cards. Use `status` to set the overall verdict; retain `diagnosis` verbatim. Since its adapter currently returns one `EvalResult`, the single-question form fits without changing UI components. `uploadDocument` can use XHR for upload progress; processing status is ready on the first poll.

## Runtime and current limits

Copy `.env.example` to `.env` and start from the repo root with `node --env-file=.env backend/server.mjs` (use the Node binary under `.tooling` if needed). In another terminal run `npm run dev`; Vite reads `VITE_API_BASE_URL` from `.env`. API keys stay in the backend process and must never use the `VITE_` prefix. PDF parsing invokes `PDFTOTEXT_PATH` if set, otherwise `pdftotext` on `PATH`; DOCX extraction invokes Python 3's standard-library ZIP/XML support. TXT/Markdown need no external parser. Legacy `.doc`, images, OCR, automatic question generation, persistence cleanup, and concurrent multi-user isolation are out of scope. Uploaded text/chunks are stored as local JSON under `backend/data/`.

