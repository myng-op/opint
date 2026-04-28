"""AzureChatOpenAI factory.

Reads the same `AZURE_AI_*` env vars the Node path uses (see
`server/src/realtime.js` chatCompletion) so the LLM is held constant
across the Node/Py paths — only the graph runtime differs.
"""
from langchain_openai import AzureChatOpenAI

from agent.config import Settings, get_settings


def get_llm(settings: Settings | None = None) -> AzureChatOpenAI:
    cfg = settings or get_settings()
    return AzureChatOpenAI(
        azure_endpoint=cfg.azure_ai_endpoint,
        api_key=cfg.azure_ai_key,
        azure_deployment=cfg.azure_ai_deployment,
        api_version=cfg.azure_ai_api_version,
    )
