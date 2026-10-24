# AI-04 RAG Evaluation Pipeline

React + TypeScript + Vite frontend with a local Node.js RAG evaluation backend. The dashboard separates retrieval quality, answer support, known-answer correctness, and the end-to-end diagnosis.

## Run locally

Install Ollama, then download a local model with `ollama pull llama3.2`. Copy `.env.example` to `.env`; it selects Ollama by default and uses the local server without an API key. Ollama must be running at `http://localhost:11434`. Uploading a new document starts a background Phase 2 job that asks local Llama for up to 200 question/answer candidates. The UI reports progress and keeps the page usable; results that do not contain evidence verified against the source are discarded, so the final count can be lower than requested. The generated pairs are AI candidates, not human labels, until two reviewers annotate them. To use no model at all, set `AI_PROVIDER=extractive`. To use a billed provider for the regular answer flow, set `AI_PROVIDER=openai` or `AI_PROVIDER=gemini` and configure that provider's key. Phase 2 generation intentionally requires Ollama and never falls back to a paid provider. Keep keys server-side; never use a `VITE_` prefix for a secret. Then run the backend and frontend in separate terminals:

For a JSON export of real Llama candidates with reviewer fields left empty, run `python3 generate_proofline_dataset.py --document-id <document-id> --count 200`. To export a job already running, pass `--job-id <job-id>`. The export is suitable for the Phase 2 case importer but explicitly reports zero human labels until real reviewers complete them. To check answer-order stability with actual system outputs, provide a JSON file containing one `{ "caseId", "answer" }` row per case, then run `python3 benchmark_runner.py --dataset-id <dataset-id> --document-id <document-id> --answers <answers.json>`. The script calls the backend's concurrent deterministic evaluator twice, with the same answers in opposite orders, and writes a stability/throughput report.

```sh
# Run this from the repository root in each terminal; this project bundles Node/npm.
export PATH="$PWD/.tooling/node-v24.22.1-darwin-arm64/bin:$PATH"

# Terminal 1
node --env-file=.env backend/server.mjs

# Terminal 2
npm run dev
```

Run the local Phase 2 checks with `npm test`; validate and build the frontend with `npm run build`.

Vite prints the local URL. The backend listens on port 8000 on localhost only by default. Ollama inference stays on your computer; no API bill is incurred. If Ollama is not installed or running, the backend falls back to extractive answers and lexical-overlap scores and reports the local connection failure.

PDF extraction requires Poppler (`pdftotext`) on `PATH`. DOCX extraction uses Python 3. PDF, DOCX, TXT, and Markdown files up to 15 MB are supported; old binary DOC files are not.

## API and demo data

The backend API contract is documented in [backend/API_CONTRACT.md](backend/API_CONTRACT.md). A ready-to-upload corpus is [backend/sample-corpus.txt](backend/sample-corpus.txt); its four known-answer questions are returned when their relevant topics are present. Uploads and chunks are stored locally under `backend/data/`.

When `VITE_API_BASE_URL` is unset, the frontend remains in its clearly marked sample mode. `.env.example` configures it to use the backend API.

## Phase 2 extension

The workbench includes a Phase 2 reviewer-labeling workflow, deterministic benchmark/confusion matrix, and same-question retrieval configuration/source comparison. Generate 150 or 200 extractive QA pairs from an uploaded document, or import your own set, then collect labels from two distinct reviewers. Generated answers are source sentences and are marked synthetic/unreviewed; they do not count toward human-label progress until reviewers label each case. The benchmark accepts actual generated outputs as an `answers` JSON array matched by case ID; without that input it clearly reports the extractive baseline only. Scoring uses query-only retrieval plus deterministic lexical checks, with no judge-model call. See [backend/API_CONTRACT.md](backend/API_CONTRACT.md#phase-2-extension) for the API and metric definitions. Generated pairs are useful for fast pipeline tests; only genuinely reviewed data supports the human-agreement checkpoint.
