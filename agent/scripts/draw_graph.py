"""Dump the agent graph's shape — ASCII to stdout, mermaid to file.

Structure-only: we don't need a working LLM or live Mongo to render.
Pass `None` for llm and an in-memory checkpointer; `build_graph` only
touches them at invoke time, not at compile.

    uv run --directory agent python scripts/draw_graph.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from langgraph.checkpoint.memory import InMemorySaver  # noqa: E402

from agent.main import build_app_graph  # noqa: E402


def main() -> int:
    graph = build_app_graph(llm=None, checkpointer=InMemorySaver())
    g = graph.get_graph()

    g.print_ascii()
ce
    out = Path(__file__).resolve().parent.parent / "graph.mmd"
    out.write_text(g.draw_mermaid(), encoding="utf-8")
    print(f"\nMermaid -> {out}")
    print("Paste contents into https://mermaid.live or any md file.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
