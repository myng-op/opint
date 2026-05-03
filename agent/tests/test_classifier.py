"""Tests for the classifier node — Phase 15.1 TDD.

Classifier takes a question's requirement + user response and returns
structured output: {satisfied: bool, missing_fragments: list[str], extracted: dict}.

Key design: English judgment prompt even for non-English interviews.
Post-check: advance requires len(missing_fragments) == 0, ignoring the boolean.
"""
import pytest
from langchain_core.messages import AIMessage


class FakeStructuredLLM:
    """Simulates .with_structured_output() by returning pre-scripted results."""

    def __init__(self, result: dict):
        self._result = result

    def invoke(self, messages):
        return self._result


class TestClassifierSatisfied:
    """When user fully answers the requirement."""

    def test_full_answer_returns_satisfied(self):
        from agent.classifier import classify

        llm = FakeStructuredLLM({
            "satisfied": True,
            "missing_fragments": [],
            "extracted": {"name": "John", "age": "30", "gender": "male"},
        })

        result = classify(
            llm=llm,
            question={"key": "q1", "content": "What is your name?", "requirement": "name, age, gender"},
            user_response="My name is John, I'm 30 years old, male.",
            language="en-US",
        )

        assert result["satisfied"] is True
        assert result["missing_fragments"] == []
        assert result["extracted"]["name"] == "John"


class TestClassifierPartial:
    """When user gives incomplete answer."""

    def test_partial_answer_returns_missing_fragments(self):
        from agent.classifier import classify

        llm = FakeStructuredLLM({
            "satisfied": False,
            "missing_fragments": ["age", "gender"],
            "extracted": {"name": "John"},
        })

        result = classify(
            llm=llm,
            question={"key": "q1", "content": "What is your name?", "requirement": "name, age, gender"},
            user_response="My name is John.",
            language="en-US",
        )

        assert result["satisfied"] is False
        assert "age" in result["missing_fragments"]
        assert "gender" in result["missing_fragments"]
        assert result["extracted"] == {"name": "John"}

    def test_post_check_overrides_satisfied_when_missing_fragments_present(self):
        from agent.classifier import classify

        llm = FakeStructuredLLM({
            "satisfied": True,  # model says satisfied but fragments still missing
            "missing_fragments": ["age"],
            "extracted": {"name": "John", "gender": "male"},
        })

        result = classify(
            llm=llm,
            question={"key": "q1", "content": "What is your name?", "requirement": "name, age, gender"},
            user_response="I'm John, male.",
            language="en-US",
        )

        # Post-check: satisfied must be False if missing_fragments non-empty
        assert result["satisfied"] is False
        assert result["missing_fragments"] == ["age"]


class TestClassifierMultilingual:
    """Finnish reply classified with English judgment prompt."""

    def test_finnish_reply_still_classifies(self):
        from agent.classifier import classify

        llm = FakeStructuredLLM({
            "satisfied": True,
            "missing_fragments": [],
            "extracted": {"name": "Matti", "age": "45", "gender": "mies"},
        })

        result = classify(
            llm=llm,
            question={"key": "q1", "content": "Mikä on nimesi?", "requirement": "name, age, gender"},
            user_response="Nimeni on Matti, olen 45-vuotias mies.",
            language="fi-FI",
        )

        assert result["satisfied"] is True
        assert result["extracted"]["name"] == "Matti"


class TestClassifierRefusal:
    """When participant refuses to answer."""

    def test_refusal_returns_unsatisfied(self):
        from agent.classifier import classify

        llm = FakeStructuredLLM({
            "satisfied": False,
            "missing_fragments": ["name", "age", "gender"],
            "extracted": {},
        })

        result = classify(
            llm=llm,
            question={"key": "q1", "content": "What is your name?", "requirement": "name, age, gender"},
            user_response="I don't want to say.",
            language="en-US",
        )

        assert result["satisfied"] is False
        assert len(result["missing_fragments"]) == 3


class TestClassifierPromptConstruction:
    """Verify the prompt sent to the LLM is in English regardless of language."""

    def test_prompt_is_english_for_finnish_interview(self):
        from agent.classifier import build_classifier_prompt

        messages = build_classifier_prompt(
            question={"key": "q1", "content": "Mikä on nimesi?", "requirement": "name, age, gender"},
            user_response="Nimeni on Matti.",
            language="fi-FI",
        )

        prompt_text = messages[0].content if hasattr(messages[0], "content") else str(messages[0])
        assert "determine" in prompt_text.lower() or "evaluate" in prompt_text.lower() or "assess" in prompt_text.lower()
        # The user's reply should be quoted verbatim
        assert "Nimeni on Matti." in str(messages)
