"""LangSmith tracing wiring (Phase 11.7, secondary DoD goal).

LangChain auto-picks up `LANGSMITH_TRACING` / `LANGSMITH_API_KEY` /
`LANGSMITH_PROJECT` from the process env. Our job is just to populate
them at boot when the user opted in. Tracing is **optional** — the
service must boot + serve without any LangSmith creds.
"""
import logging
import os

from agent.config import Settings

log = logging.getLogger(__name__)


def configure_langsmith(settings: Settings) -> None:
    if not settings.langsmith_tracing:
        log.info("[langsmith] tracing disabled (LANGSMITH_TRACING != 'true')")
        return

    os.environ["LANGSMITH_TRACING"] = "true"
    if settings.langsmith_api_key:
        os.environ["LANGSMITH_API_KEY"] = settings.langsmith_api_key
    if settings.langsmith_project:
        os.environ["LANGSMITH_PROJECT"] = settings.langsmith_project

    log.info(
        "[langsmith] tracing enabled — project=%s key=<%d chars>",
        settings.langsmith_project,
        len(settings.langsmith_api_key),
    )
