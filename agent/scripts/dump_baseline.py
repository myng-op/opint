"""Capture a Node-path interview's transcript shape as the parity baseline.

DoD gate 1 (Phase 11.7): we don't compare text equality (LLM is
non-deterministic) — only structural shape. Dumps `turn count`,
`role sequence`, and `per-turn text length` for one completed
interview to `tests/fixtures/sample_baseline.json`. The Py path can
then assert it produces the same shape end-to-end.

Run this after a manual interview with USE_PY_AGENT=false so the
captured run reflects Node's behaviour:

    INTERVIEW_ID=<completed-oid> uv run python scripts/dump_baseline.py
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from pymongo import MongoClient

from agent.config import get_settings


def main() -> int:
    interview_id = os.environ.get("INTERVIEW_ID")
    if not interview_id:
        print("Set INTERVIEW_ID=<oid of a completed interview>")
        return 1

    out_dir = Path(__file__).resolve().parents[1] / "tests" / "fixtures"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "sample_baseline.json"

    cfg = get_settings()
    client = MongoClient(cfg.mongo_uri)
    db = client[cfg.mongo_db]

    from bson import ObjectId

    turns = list(
        db.transcriptturns.find({"interviewId": ObjectId(interview_id)}).sort("sequence", 1)
    )
    if not turns:
        print(f"No transcript turns for {interview_id} — was the interview run?")
        return 1

    baseline = {
        "interviewId": interview_id,
        "turn_count": len(turns),
        "roles": [t["role"] for t in turns],
        "text_lengths": [len(t.get("text") or "") for t in turns],
    }
    out_path.write_text(json.dumps(baseline, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote baseline: turns={baseline['turn_count']} → {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
