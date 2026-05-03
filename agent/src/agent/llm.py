"""AzureChatOpenAI factory.

Reads the same `AZURE_AI_*` env vars the Node path uses (see
`server/src/realtime.js` chatCompletion) so the LLM is held constant
across the Node/Py paths — only the graph runtime differs.
"""
import re

from langchain_openai import AzureChatOpenAI

from agent.config import Settings, get_settings

# Mirror server/src/realtime.js:66 — accept endpoints written with or
# without a trailing /openai/vN segment. AzureChatOpenAI wants the bare
# resource host; the langchain client appends /openai/deployments/...
_ENDPOINT_SUFFIX_RE = re.compile(r"/openai/v\d+/?$")


def _normalize_endpoint(endpoint: str) -> str:
    return _ENDPOINT_SUFFIX_RE.sub("", endpoint).rstrip("/") + "/"


def get_llm(settings: Settings | None = None) -> AzureChatOpenAI:
    cfg = settings or get_settings()
    return AzureChatOpenAI(
        azure_endpoint=_normalize_endpoint(cfg.azure_ai_endpoint),
        api_key=cfg.azure_ai_key,
        azure_deployment=cfg.azure_ai_deployment,
        api_version=cfg.azure_ai_api_version,
    )
