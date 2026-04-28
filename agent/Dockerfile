FROM python:3.12-slim AS builder

COPY --from=ghcr.io/astral-sh/uv:0.10.8 /uv /uvx /usr/local/bin/

WORKDIR /app
ENV UV_LINK_MODE=copy

COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev

COPY src/ ./src/

FROM python:3.12-slim

WORKDIR /app
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/src /app/src

ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONPATH="/app/src"

EXPOSE 8001
CMD ["uvicorn", "agent.main:app", "--host", "0.0.0.0", "--port", "8001"]
