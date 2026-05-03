"""Tests for the followup node — Phase 15.1 TDD.

Followup generates a natural-language request for missing fragments only.
Cap: after 2 unsatisfied followups, advance is forced (no more followups).
"""
import pytest


class FakeFollowupLLM:
    """Returns pre-scripted followup text."""

    def __init__(self, text: str):
        self._text = text

    def invoke(self, messages):
        from langchain_core.messages import AIMessage
        return AIMessage(content=self._text)


class TestFollowupGeneration:
    """Followup asks for missing fields only."""

    def test_generates_followup_for_missing_fragments(self):
        from agent.followup import generate_followup

        llm = FakeFollowupLLM("Could you also tell me your age and gender?")

        result = generate_followup(
            llm=llm,
            question={"key": "q1", "content": "What is your name?", "requirement": "name, age, gender"},
            missing_fragments=["age", "gender"],
            language="en-US",
        )

        assert isinstance(result, str)
        assert len(result) > 0

    def test_followup_prompt_mentions_missing_fragments(self):
        from agent.followup import build_followup_prompt

        messages = build_followup_prompt(
            question={"key": "q1", "content": "What is your name?", "requirement": "name, age, gender"},
            missing_fragments=["age", "gender"],
            language="en-US",
        )

        prompt_text = str(messages)
        assert "age" in prompt_text
        assert "gender" in prompt_text


class TestFollowupCap:
    """After 2 followups, no more followup is generated — advance is forced."""

    def test_should_followup_true_when_under_cap(self):
        from agent.followup import should_followup

        assert should_followup(followup_count=0) is True
        assert should_followup(followup_count=1) is True

    def test_should_followup_false_at_cap(self):
        from agent.followup import should_followup

        assert should_followup(followup_count=2) is False
        assert should_followup(followup_count=5) is False
