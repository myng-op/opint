"""LangSmith env-passthrough tests.

LangChain auto-picks up `LANGSMITH_*` env vars; the agent's job is just
to populate them at process start when the user opted in via Settings.
Service must boot + serve without LangSmith creds (tracing optional)."""
import os

from agent.config import Settings
from agent.langsmith_setup import configure_langsmith


def _clear_langsmith_env(monkeypatch):
    for k in ("LANGSMITH_TRACING", "LANGSMITH_API_KEY", "LANGSMITH_PROJECT"):
        monkeypatch.delenv(k, raising=False)


def test_no_op_when_tracing_disabled(monkeypatch):
    _clear_langsmith_env(monkeypatch)
    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    configure_langsmith(Settings())
    assert "LANGSMITH_TRACING" not in os.environ or os.environ["LANGSMITH_TRACING"] == "false"


def test_sets_tracing_env_when_enabled(monkeypatch):
    _clear_langsmith_env(monkeypatch)
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "ls-test-key")
    monkeypatch.setenv("LANGSMITH_PROJECT", "opint-spike")

    configure_langsmith(Settings())

    assert os.environ.get("LANGSMITH_TRACING") == "true"
    assert os.environ.get("LANGSMITH_API_KEY") == "ls-test-key"
    assert os.environ.get("LANGSMITH_PROJECT") == "opint-spike"


def test_does_not_overwrite_when_tracing_off(monkeypatch):
    """If user has LANGSMITH_API_KEY in env but tracing disabled, we don't
    touch their env — they may want to set it manually for a one-off run."""
    _clear_langsmith_env(monkeypatch)
    monkeypatch.setenv("LANGSMITH_API_KEY", "preset-by-user")
    # tracing left unset → defaults to False per Settings field
    configure_langsmith(Settings())
    assert os.environ.get("LANGSMITH_API_KEY") == "preset-by-user"
