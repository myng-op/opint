"""Integration tests for the state-machine graph — Phase 15.1 TDD.

Tests full happy-path interview and refusal path (2 followups → forced advance).
Uses scripted LLMs for deterministic outputs.

This file will replace test_graph.py once the ReAct → state-machine rewrite lands.
"""
from datetime import datetime, timezone

import pytest
from bson import ObjectId
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage


class FakeRendererLLM:
    """Returns scripted text responses in order."""

    def __init__(self, responses: list[str]):
        self._responses = responses
        self._idx = 0

    def invoke(self, messages):
        text = self._responses[self._idx % len(self._responses)]
        self._idx += 1
        return AIMessage(content=text)


class FakeClassifierLLM:
    """Returns scripted classification dicts in order."""

    def __init__(self, results: list[dict]):
        self._results = results
        self._idx = 0

    def invoke(self, messages):
        result = self._results[self._idx]
        self._idx += 1
        return result


class FakeFollowupLLM:
    """Returns scripted followup text."""

    def __init__(self, responses: list[str]):
        self._responses = responses
        self._idx = 0

    def invoke(self, messages):
        text = self._responses[self._idx % len(self._responses)]
        self._idx += 1
        return AIMessage(content=text)


@pytest.fixture
def sm_question_set():
    return {
        "_id": ObjectId(),
        "title": "state_machine_test_set",
        "questions": [
            {"key": "intro", "content": "Welcome to this interview.", "type": "non-question", "requirement": "", "condition": "", "maxSec": None},
            {"key": "q1", "content": "What is your name, age, and gender?", "type": "factual", "requirement": "name, age, gender", "condition": "", "maxSec": 60},
            {"key": "q2", "content": "Tell me about your day.", "type": "qualitative", "requirement": "general description", "condition": "", "maxSec": 120},
            {"key": "closing", "content": "Thank you for your time.", "type": "non-question", "requirement": "", "condition": "", "maxSec": None},
        ],
    }


@pytest.fixture
def sm_interview_id(db, sm_question_set):
    now = datetime.now(timezone.utc)
    res = db.interviews.insert_one(
        {
            "questionSetId": sm_question_set["_id"],
            "status": "pending",
            "currentIndex": 0,
            "language": "en-US",
            "ttsVoice": "",
            "createdAt": now,
            "updatedAt": now,
        }
    )
    return str(res.inserted_id)


class TestStateMachineHappyPath:
    """Full interview: intro (non-q auto-advance) → q1 (satisfied) → q2 (satisfied) → closing → done."""

    def test_open_renders_intro_and_first_question(
        self, db, sm_interview_id, sm_question_set
    ):
        from agent.state_graph import run_open

        renderer = FakeRendererLLM(["Welcome!", "What is your name, age, and gender?"])

        result = run_open(
            db=db,
            interview_id=sm_interview_id,
            question_set=sm_question_set,
            renderer_llm=renderer,
        )

        assert len(result["assistant_texts"]) >= 1
        interview = db.interviews.find_one({"_id": ObjectId(sm_interview_id)})
        # Non-question auto-advances, stops at first real question
        assert interview["currentIndex"] == 1

    def test_turn_full_answer_advances_to_next_question(
        self, db, sm_interview_id, sm_question_set
    ):
        from agent.state_graph import run_open, run_turn

        renderer = FakeRendererLLM([
            "Welcome!",
            "What is your name, age, and gender?",
            "Tell me about your day.",
        ])
        classifier = FakeClassifierLLM([
            {"satisfied": True, "missing_fragments": [], "extracted": {"name": "John", "age": "30", "gender": "male"}},
        ])

        run_open(db=db, interview_id=sm_interview_id, question_set=sm_question_set, renderer_llm=renderer)

        result = run_turn(
            db=db,
            interview_id=sm_interview_id,
            question_set=sm_question_set,
            user_text="My name is John, 30 years old, male.",
            renderer_llm=renderer,
            classifier_llm=classifier,
        )

        interview = db.interviews.find_one({"_id": ObjectId(sm_interview_id)})
        assert interview["currentIndex"] == 2
        assert interview["responses"]["q1"]["satisfied"] is True
        assert interview["responses"]["q1"]["extracted"]["name"] == "John"
        assert "assistant_texts" in result
        assert len(result["assistant_texts"]) >= 1


class TestStateMachineRefusalPath:
    """2 followups → forced advance with warning."""

    def test_followup_cap_forces_advance(self, db, sm_question_set):
        from agent.state_graph import run_open, run_turn

        now = datetime.now(timezone.utc)
        res = db.interviews.insert_one(
            {
                "questionSetId": sm_question_set["_id"],
                "status": "in_progress",
                "currentIndex": 1,  # start at q1 directly
                "language": "en-US",
                "ttsVoice": "",
                "createdAt": now,
                "updatedAt": now,
            }
        )
        iid = str(res.inserted_id)

        renderer = FakeRendererLLM([
            "What is your name, age, and gender?",
            "Could you tell me your age and gender?",
            "I just need age and gender.",
            "Tell me about your day.",
        ])
        classifier = FakeClassifierLLM([
            {"satisfied": False, "missing_fragments": ["age", "gender"], "extracted": {"name": "John"}},
            {"satisfied": False, "missing_fragments": ["age", "gender"], "extracted": {"name": "John"}},
            {"satisfied": False, "missing_fragments": ["age", "gender"], "extracted": {"name": "John"}},
        ])
        followup = FakeFollowupLLM([
            "Could you also tell me your age and gender?",
            "I just need your age and gender.",
        ])

        run_open(db=db, interview_id=iid, question_set=sm_question_set, renderer_llm=renderer)

        # Turn 1: partial → followup
        run_turn(
            db=db, interview_id=iid, question_set=sm_question_set,
            user_text="My name is John.",
            renderer_llm=renderer, classifier_llm=classifier, followup_llm=followup,
        )
        interview = db.interviews.find_one({"_id": ObjectId(iid)})
        assert interview["currentIndex"] == 1

        # Turn 2: refuses → followup 2
        run_turn(
            db=db, interview_id=iid, question_set=sm_question_set,
            user_text="I don't want to say.",
            renderer_llm=renderer, classifier_llm=classifier, followup_llm=followup,
        )
        interview = db.interviews.find_one({"_id": ObjectId(iid)})
        assert interview["currentIndex"] == 1

        # Turn 3: cap hit → forced advance
        result = run_turn(
            db=db, interview_id=iid, question_set=sm_question_set,
            user_text="No.",
            renderer_llm=renderer, classifier_llm=classifier, followup_llm=followup,
        )
        interview = db.interviews.find_one({"_id": ObjectId(iid)})
        assert interview["currentIndex"] == 2
        assert interview["responses"]["q1"]["satisfied"] is False
