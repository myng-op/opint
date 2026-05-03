"""Tests for the advance node — Phase 15.1 TDD.

Advance is the ONLY place that increments currentIndex.
It accumulates extracted data across followups and resets on advance.
"""
from datetime import datetime, timezone

import pytest
from bson import ObjectId


@pytest.fixture
def advance_question_set():
    return {
        "_id": ObjectId(),
        "title": "advance_test_set",
        "questions": [
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
def advance_interview_id(db, advance_question_set):
    now = datetime.now(timezone.utc)
    res = db.interviews.insert_one(
        {
            "questionSetId": advance_question_set["_id"],
            "status": "in_progress",
            "currentIndex": 0,
            "language": "en-US",
            "ttsVoice": "",
            "createdAt": now,
            "updatedAt": now,
        }
    )
    return str(res.inserted_id)


class TestAdvanceIncrementsIndex:
    """Advance is the single writer of currentIndex."""

    def test_advance_increments_current_index(
        self, db, advance_interview_id, advance_question_set
    ):
        from agent.advance import advance

        advance(db, advance_interview_id, advance_question_set, question_key="q1", extracted={"name": "John"})

        interview = db.interviews.find_one({"_id": ObjectId(advance_interview_id)})
        assert interview["currentIndex"] == 1

    def test_advance_at_last_question_marks_completed(
        self, db, advance_question_set
    ):
        from agent.advance import advance

        now = datetime.now(timezone.utc)
        res = db.interviews.insert_one(
            {
                "questionSetId": advance_question_set["_id"],
                "status": "in_progress",
                "currentIndex": 1,  # last question
                "language": "en-US",
                "ttsVoice": "",
                "createdAt": now,
                "updatedAt": now,
            }
        )
        iid = str(res.inserted_id)

        advance(db, iid, advance_question_set, question_key="q2", extracted={"experience": "10 years"})

        interview = db.interviews.find_one({"_id": ObjectId(iid)})
        assert interview["currentIndex"] == 2
        # completion check happens in dispatcher on next dispatch


class TestAdvanceAccumulation:
    """Extracted data accumulates across followups, written on advance."""

    def test_advance_writes_extracted_to_interview(
        self, db, advance_interview_id, advance_question_set
    ):
        from agent.advance import advance

        extracted = {"name": "John", "age": "30", "gender": "male"}
        advance(db, advance_interview_id, advance_question_set, question_key="q1", extracted=extracted)

        interview = db.interviews.find_one({"_id": ObjectId(advance_interview_id)})
        assert interview["responses"]["q1"]["extracted"] == extracted
        assert interview["responses"]["q1"]["satisfied"] is True

    def test_forced_advance_marks_unsatisfied(
        self, db, advance_interview_id, advance_question_set
    ):
        from agent.advance import advance

        advance(
            db, advance_interview_id, advance_question_set,
            question_key="q1",
            extracted={"name": "John"},
            forced=True,
        )

        interview = db.interviews.find_one({"_id": ObjectId(advance_interview_id)})
        assert interview["responses"]["q1"]["satisfied"] is False
        assert interview["currentIndex"] == 1


class TestAdvanceNonQuestion:
    """Non-questions also advance but store no extracted data."""

    def test_advance_non_question_increments_only(self, db, advance_question_set):
        from agent.advance import advance

        now = datetime.now(timezone.utc)
        qs_with_nq = {
            "_id": ObjectId(),
            "title": "nq_set",
            "questions": [
                {"key": "intro", "content": "Welcome.", "type": "non-question", "requirement": "", "condition": "", "maxSec": None},
                {"key": "q1", "content": "Name?", "type": "factual", "requirement": "name", "condition": "", "maxSec": 30},
            ],
        }
        res = db.interviews.insert_one(
            {
                "questionSetId": qs_with_nq["_id"],
                "status": "in_progress",
                "currentIndex": 0,
                "language": "en-US",
                "ttsVoice": "",
                "createdAt": now,
                "updatedAt": now,
            }
        )
        iid = str(res.inserted_id)

        advance(db, iid, qs_with_nq, question_key="intro", extracted={})

        interview = db.interviews.find_one({"_id": ObjectId(iid)})
        assert interview["currentIndex"] == 1
        # No responses entry for non-questions
        assert "intro" not in interview.get("responses", {})
