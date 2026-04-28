# opint agent (Python LangGraph sidecar)

Experimental LangGraph-based agent service. Runs alongside the Node server.
See `/Users/b743595/dev/opint/ARCHITECTURE.md` and `/Users/b743595/dev/opint/prompts/manifest.md` Phase 11.

## Local dev

```
cd agent
uv sync
uv run uvicorn agent.main:app --reload --port 8001
uv run pytest
```

## Container

```
docker compose up agent
```

Activated in Node when `USE_PY_AGENT=true` in repo-root `.env`.
