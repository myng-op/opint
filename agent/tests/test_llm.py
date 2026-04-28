"""LLM factory tests — written cycle-4 of Phase 11.4."""
from langchain_openai import AzureChatOpenAI


def test_get_llm_constructs_azure_chat_openai(monkeypatch):
    monkeypatch.setenv("AZURE_AI_ENDPOINT", "https://example.openai.azure.com/")
    monkeypatch.setenv("AZURE_AI_KEY", "test-key")
    monkeypatch.setenv("AZURE_AI_DEPLOYMENT", "test-deploy")
    monkeypatch.setenv("AZURE_AI_API_VERSION", "2024-10-21")

    from agent.config import Settings
    from agent.llm import get_llm

    llm = get_llm(Settings())

    assert isinstance(llm, AzureChatOpenAI)
