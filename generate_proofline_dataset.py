#!/usr/bin/env python3
"""Export local Ollama-generated QA candidates for genuine human review.

Reviewer fields intentionally remain empty. AI-generated labels must never be
reported as human verification or inter-annotator agreement.
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
    headers = {"Content-Type": "application/json"} if data is not None else {}
    try:
        with urlopen(Request(url, data=data, headers=headers), timeout=120) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Backend returned HTTP {error.code}: {detail}") from error
    except URLError as error:
        raise RuntimeError(f"Could not reach the backend: {error.reason}") from error


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", default="http://localhost:8001/api")
    parser.add_argument("--document-id", help="Required when starting a new generation job")
    parser.add_argument("--job-id", help="Export an already-running generation job")
    parser.add_argument("--dataset-id", help="Export an existing dataset, including any genuine saved reviewer labels")
    parser.add_argument("--count", type=int, choices=(110, 150, 200), default=200)
    parser.add_argument("--limit", type=int, default=150, help="Export at most this many real generated candidates")
    parser.add_argument("--output", type=Path, default=Path("final_evaluated_dataset.json"))
    args = parser.parse_args()
    if args.limit < 1:
        parser.error("--limit must be positive")
    root = args.api.rstrip("/")

    if args.job_id and args.dataset_id:
        parser.error("Use --job-id or --dataset-id, not both")
    if args.job_id:
        job = request_json(f"{root}/phase2/generation-jobs/{args.job_id}")
    elif args.dataset_id:
        job = None
    else:
        if not args.document_id:
            parser.error("--document-id is required unless --job-id is supplied")
        job = request_json(f"{root}/phase2/generate-dataset", {
            "documentId": args.document_id,
            "count": args.count,
        })
        print(f"Started local Ollama job {job['id']} for {job['requestedCount']} candidates.")

    last_progress = None
    if job is not None:
        while job["status"] in ("queued", "running"):
            current_progress = (job["status"], job["generatedCount"], job["progress"])
            if current_progress != last_progress:
                print(f"{job['status']}: {job['generatedCount']}/{job['requestedCount']} verified candidates; {job['progress']}%", flush=True)
                last_progress = current_progress
            time.sleep(2)
            job = request_json(f"{root}/phase2/generation-jobs/{job['id']}")
        if job["status"] == "failed" or not job.get("datasetId"):
            raise RuntimeError(job.get("error") or "Llama generation failed without a dataset.")
        dataset_id = job["datasetId"]
    else:
        dataset_id = args.dataset_id

    dataset = request_json(f"{root}/phase2/datasets/{dataset_id}")
    cases = []
    for item in dataset["cases"][:max(1, args.limit)]:
        annotations = sorted(item.get("annotations", []), key=lambda row: row["annotatorId"])

        def export_reviewer(annotation: dict | None) -> dict | None:
            if annotation is None:
                return None
            passing = annotation["failureType"] == "none" and annotation["answerCorrect"] and annotation["evidenceRelevant"]
            failing = annotation["failureType"] != "none" and not annotation["answerCorrect"] and not annotation["evidenceRelevant"]
            label = "Pass" if passing else "Fail" if failing else "Partial"
            return {
                "annotator_id": annotation["annotatorId"],
                "label": label,
                "failure_type": annotation["failureType"],
                "answer_correct": annotation["answerCorrect"],
                "evidence_relevant": annotation["evidenceRelevant"],
            }

        first = annotations[0] if annotations else None
        second = annotations[1] if len(annotations) > 1 else None
        agrees = None if second is None else all(
            first[key] == second[key] for key in ("failureType", "answerCorrect", "evidenceRelevant")
        )
        cases.append({
            "id": item["id"],
            "question": item["question"],
            "referenceAnswer": item["referenceAnswer"],
            "expectedEvidence": item.get("expectedEvidence", ""),
            "expectedSource": item.get("expectedSource", ""),
            "expectedPage": item.get("expectedPage"),
            "annotations": annotations,
            "reviewer_1": export_reviewer(first),
            "reviewer_2": export_reviewer(second),
            "agreement": agrees,
        })

    reviewed = [row for row in cases if row["reviewer_1"] is not None and row["reviewer_2"] is not None]
    full_agreement = [row for row in reviewed if row["agreement"]]
    failure_agreement = [row for row in reviewed if row["reviewer_1"]["failure_type"] == row["reviewer_2"]["failure_type"]]
    failure_labels = sorted({row[key]["failure_type"] for row in reviewed for key in ("reviewer_1", "reviewer_2")})
    observed = len(failure_agreement) / len(reviewed) if reviewed else None
    expected = 0.0
    if reviewed:
        for failure_type in failure_labels:
            first_rate = sum(row["reviewer_1"]["failure_type"] == failure_type for row in reviewed) / len(reviewed)
            second_rate = sum(row["reviewer_2"]["failure_type"] == failure_type for row in reviewed) / len(reviewed)
            expected += first_rate * second_rate
    kappa = None if observed is None else (1.0 if expected == 1 and observed == 1 else 0.0 if expected == 1 else round((observed - expected) / (1 - expected), 3))

    output = {
        "name": dataset["name"],
        "datasetId": dataset["id"],
        "generationMetadata": dataset.get("generationMetadata"),
        "reviewStatus": "AI candidates; only saved reviewer records are counted as human review.",
        "reviewerLabelMapping": "Pass = no failure and both answer/evidence checks are true; Fail = named failure and both checks are false; otherwise Partial.",
        "summary": {
            "totalItems": len(cases),
            "doubleLabeledCount": len(reviewed),
            "fullyAgreedCount": len(full_agreement),
            "agreementPercentage": round(len(full_agreement) / len(reviewed) * 100, 1) if reviewed else None,
            "failureTypeAgreementPercentage": round(len(failure_agreement) / len(reviewed) * 100, 1) if reviewed else None,
            "cohensKappaFailureType": kappa,
            "150HumanAgreementTargetMet": len(full_agreement) >= 150,
            "enoughCandidatesFor150": len(cases) >= 150,
        },
        "cases": cases,
    }
    args.output.write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Saved {len(cases)} unreviewed candidates to {args.output}. Human-review target met: no.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, json.JSONDecodeError, RuntimeError, KeyError) as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(2)
