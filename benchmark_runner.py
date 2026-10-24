#!/usr/bin/env python3
"""Run the existing local Phase 2 evaluator twice to verify answer-order stability.

This script requires actual system answers matched to dataset case IDs. It does
not invent answers, reviewer labels, or agreement statistics.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def request_json(url: str, payload: dict | None = None) -> dict | list:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(url, data=data, headers={"Content-Type": "application/json"} if data else {})
    try:
        with urlopen(request, timeout=120) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Backend returned HTTP {error.code}: {detail}") from error
    except URLError as error:
        raise RuntimeError(f"Could not reach the backend: {error.reason}") from error


def run() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", default="http://localhost:8001/api", help="Backend API base URL")
    parser.add_argument("--dataset-id", required=True)
    parser.add_argument("--document-id", required=True)
    parser.add_argument("--answers", required=True, type=Path,
                        help="JSON file with real outputs: {\"answers\":[{\"caseId\":\"...\",\"answer\":\"...\"}]}")
    parser.add_argument("--output", type=Path, default=Path("benchmark_stability_report.json"))
    args = parser.parse_args()

    answers_doc = json.loads(args.answers.read_text(encoding="utf-8"))
    answers = answers_doc.get("answers") if isinstance(answers_doc, dict) else None
    if not isinstance(answers, list) or not answers:
        raise RuntimeError("The answers file must contain a non-empty answers array.")

    root = args.api.rstrip("/")
    dataset = request_json(f"{root}/phase2/datasets/{args.dataset_id}")
    expected = {row["id"] for row in dataset.get("cases", [])}
    received = [row.get("caseId") for row in answers if isinstance(row, dict)]
    if len(received) != len(answers) or set(received) != expected or len(received) != len(expected):
        raise RuntimeError("Provide exactly one real answer for every dataset caseId, with no missing or duplicate IDs.")

    def benchmark(rows: list[dict]) -> dict:
        return request_json(f"{root}/phase2/benchmark", {
            "datasetId": args.dataset_id,
            "documentId": args.document_id,
            "answers": rows,
        })

    first_started = time.perf_counter()
    first = benchmark(answers)
    first_wall_ms = round((time.perf_counter() - first_started) * 1000, 2)
    shuffled_started = time.perf_counter()
    shuffled = benchmark(list(reversed(answers)))
    shuffled_wall_ms = round((time.perf_counter() - shuffled_started) * 1000, 2)

    def stable_rows(report: dict) -> dict:
        return {
            row["caseId"]: {
                "scores": row["scores"],
                "predictedFailure": row["predictedFailure"],
                "diagnosis": row["diagnosis"],
            }
            for row in report["results"]
        }

    first_rows = stable_rows(first)
    shuffled_rows = stable_rows(shuffled)
    output = {
        "datasetId": args.dataset_id,
        "documentId": args.document_id,
        "questionCount": len(answers),
        "orderInvariant": first_rows == shuffled_rows,
        "judgeModelCalls": 0,
        "scoringMethod": "Backend query-only retrieval plus deterministic lexical scoring; answers aligned by caseId.",
        "runs": [
            {"wallMs": first_wall_ms, "backendMs": first["performance"]["durationMs"],
             "questionsPerMinute": first["performance"]["questionsPerMinute"]},
            {"wallMs": shuffled_wall_ms, "backendMs": shuffled["performance"]["durationMs"],
             "questionsPerMinute": shuffled["performance"]["questionsPerMinute"]},
        ],
        "note": "Stability check only. It does not establish correctness against human reviewers; use two genuine independent label sets for that claim.",
    }
    args.output.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(output, indent=2))
    return 0 if output["orderInvariant"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(run())
    except (OSError, json.JSONDecodeError, RuntimeError, KeyError) as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(2)
