"""Tests for the dispatcher node — Phase 15.1 TDD.

Dispatcher reads currentIndex from Mongo, fetches the question at that index,
and routes accordingly. Critical invariant: dispatcher NEVER increments the index.
"""
from datetime import datetime, timezone

import pytest
from bson import ObjectId


@pytest.fixture
def multi_question_set():
    """Set with non-question first, then a real question, then another question."""
    return {
        "_id": ObjectId(),
        "title": "multi_set",
        "questions": [
            {
                "key": "intro",
                "content": "Welcome to this interview.",
                "type": "non-question",
                "requirement": "",
                "condition": "",
                "maxSec": None,
            },
            {
                "key": "q1",
                "content": "What is your name?",
                "type": "factual",
                "requirement": "name, age, gender",
                "condition": "",
                "maxSec": 60,
            },
            {
                "key": "q2",
                "content": "Tell me about your experience.",
                "type": "qualitative",
                "requirement": "description of experience",
                "condition": "",
                "maxSec": 120,
            },
        ],
    }


@pytest.fixture
def interview_at_index(db, multi_question_set):
    """Factory: insert an interview at a given currentIndex."""
    def _make(index: int = 0):
        now = datetime.now(timezone.utc)
        res = db.interviews.insert_one(
            {
                "questionSetId": multi_question_set["_id"],
                "status": "in_progress" if index > 0 else "pending",
                "currentIndex": index,
                "language": "en-US",
                "ttsVoice": "",
                "createdAt": now,
                "updatedAt": now,
            }
        )
        return str(res.inserted_id)
    return _make


class TestDispatcherNonQuestion:
    """Non-question items are rendered immediately; dispatcher loops."""

    def test_non_question_sets_current_question_with_type(
        self, db, multi_question_set, interview_at_index
    ):
        from agent.dispatcher import dispatch

        iid = interview_at_index(index=0)
        result = dispatch(db, iid, multi_question_set)

        assert result["current_question"]["key"] == "intro"
        assert result["current_question"]["type"] == "non-question"
        assert result["route"] == "non_question"

    def test_non_question_does_not_increment_index(
        self, db, multi_question_set, interview_at_index
    ):
        from agent.dispatcher import dispatch

        iid = interview_at_index(index=0)
        dispatch(db, iid, multi_question_set)

        interview = db.interviews.find_one({"_id": ObjectId(iid)})
        assert interview["currentIndex"] == 0


class TestDispatcherQuestion:
    """Real questions are rendered and awaited."""

    def test_question_sets_current_question(
        self, db, multi_question_set, interview_at_index
    ):
        from agent.dispatcher import dispatch

        iid = interview_at_index(index=1)
        result = dispatch(db, iid, multi_question_set)

        assert result["current_question"]["key"] == "q1"
        assert result["current_question"]["type"] == "factual"
        assert result["current_question"]["requirement"] == "name, age, gender"
        assert result["route"] == "question"

    def test_question_does_not_increment_index(
        self, db, multi_question_set, interview_at_index
    ):
        from agent.dispatcher import dispatch

        iid = interview_at_index(index=1)
        dispatch(db, iid, multi_question_set)

        interview = db.interviews.find_one({"_id": ObjectId(iid)})
        assert interview["currentIndex"] == 1


class TestDispatcherExhausted:
    """When all questions consumed, dispatcher signals done."""

    def test_exhausted_returns_done(
        self, db, multi_question_set, interview_at_index
    ):
        from agent.dispatcher import dispatch

        iid = interview_at_index(index=3)  # past last question
        result = dispatch(db, iid, multi_question_set)

        assert result["done"] is True
        assert "closing_note" in result
        assert result["route"] == "done"


class TestDispatcherStatusTransition:
    """First dispatch flips pending → in_progress."""

    def test_pending_flips_to_in_progress(
        self, db, multi_question_set, interview_at_index
    ):
        from agent.dispatcher import dispatch

        iid = interview_at_index(index=0)
        dispatch(db, iid, multi_question_set)

        interview = db.interviews.find_one({"_id": ObjectId(iid)})
        assert interview["status"] == "in_progress"
        assert isinstance(interview["startedAt"], datetime)

    def test_already_in_progress_not_restamped(
        self, db, multi_question_set, interview_at_index
    ):
        from agent.dispatcher import dispatch

        iid = interview_at_index(index=1)  # starts as in_progress
        dispatch(db, iid, multi_question_set)

        interview = db.interviews.find_one({"_id": ObjectId(iid)})
        assert "startedAt" not in interview
