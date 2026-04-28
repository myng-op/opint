"""Session helpers — build the per-interview SystemMessage etc."""
from langchain_core.messages import SystemMessage

from agent.prompts import build_system_prompt


def system_message_for(interview: dict) -> SystemMessage:
    language = interview.get("language") or None
    return SystemMessage(content=build_system_prompt(language))
