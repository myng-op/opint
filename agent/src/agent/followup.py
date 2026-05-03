"""Followup node — generates a natural request for missing fragments only.

Cap: 2 followups max per question. After that, advance is forced.
"""
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

FOLLOWUP_CAP = 2

FOLLOWUP_SYSTEM_PROMPT = """You are Anna, a warm research interviewer. The participant has given a partial answer.
Ask naturally for ONLY the missing information listed below. Do not repeat what they already told you.
Keep it brief, conversational, and gentle. One or two sentences max."""


def build_followup_prompt(
    question: dict,
    missing_fragments: list[str],
    language: str | None,
) -> list:
    missing_str = ", ".join(missing_fragments)
    user_content = (
        f"The question was: {question['content']}\n"
        f"Missing information: {missing_str}\n"
    )
    if language and not language.startswith("en"):
        user_content += f"\nRespond in the interview language ({language})."
    else:
        user_content += "\nRespond in English."

    return [
        SystemMessage(content=FOLLOWUP_SYSTEM_PROMPT),
        HumanMessage(content=user_content),
    ]


def generate_followup(
    llm,
    question: dict,
    missing_fragments: list[str],
    language: str | None,
) -> str:
    """Generate a followup asking for missing fragments only."""
    messages = build_followup_prompt(question, missing_fragments, language)
    result = llm.invoke(messages)
    if isinstance(result, AIMessage):
        return result.content
    return str(result)


def should_followup(followup_count: int) -> bool:
    """Return True if another followup is allowed (under cap)."""
    return followup_count < FOLLOWUP_CAP
