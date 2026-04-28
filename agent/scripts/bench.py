"""Latency benchmark for the Py LangGraph path (DoD gate 3).

Runs N turns end-to-end against live Azure. Gated by `BENCH_LIVE=1` so
nothing fires during a casual `uv run pytest` or local check. Compare
the printed p50/p95 against a manual run with USE_PY_AGENT=false to
verify the ≤1.5× budget.

Usage:
    BENCH_LIVE=1 INTERVIEW_ID=<oid> uv run python scripts/bench.py
"""
from __future__ import annotations

import os
import statistics
import sys
import time

import httpx


def main() -> int:
    if os.environ.get("BENCH_LIVE") != "1":
        print("Set BENCH_LIVE=1 to run (uses real Azure quota).")
        return 0

    interview_id = os.environ.get("INTERVIEW_ID")
    if not interview_id:
        print("Set INTERVIEW_ID=<existing pending interview oid>")
        return 1

    base = os.environ.get("PY_AGENT_URL", "http://localhost:8001")
    n = int(os.environ.get("BENCH_N", "10"))
    canned = ["Yes.", "Maybe.", "I think so.", "Hmm.", "Tell me more."]

    print(f"Opening {interview_id}...")
    r = httpx.post(f"{base}/open", json={"interviewId": interview_id}, timeout=60)
    r.raise_for_status()
    print(f"  greeting: {r.json()['assistantText'][:80]}…")

    timings: list[float] = []
    for i in range(n):
        body = {"interviewId": interview_id, "userText": canned[i % len(canned)]}
        t0 = time.monotonic()
        r = httpx.post(f"{base}/turn", json=body, timeout=60)
        elapsed_ms = (time.monotonic() - t0) * 1000
        r.raise_for_status()
        timings.append(elapsed_ms)
        text = r.json().get("assistantText", "")
        print(f"  turn {i + 1}/{n}: {elapsed_ms:6.0f}ms — {text[:60]}…")

    timings.sort()
    p50 = statistics.median(timings)
    p95 = timings[int(0.95 * (len(timings) - 1))]
    print()
    print(f"N={n} turns | p50={p50:.0f}ms | p95={p95:.0f}ms | "
          f"min={timings[0]:.0f}ms | max={timings[-1]:.0f}ms")
    return 0


if __name__ == "__main__":
    sys.exit(main())
