"""Tests for resume behaviour — Phase 15.1 TDD.

Key invariant: /open after dispatcher rendered a question but before user
replied must NOT re-render (no double-ask). Detect via "last message is
unanswered AIMessage" in checkpoint state.

Also: idx-not-incremented-on-fetch invariant preserved across resume.
"""
from datetime import datetime, timezone

import pytest
from bson import ObjectId
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage


@pytest.fixture
def resume_question_set():
    return {
        "_id": ObjectId(),
        "title": "resume_set",
        "questions": [
            {"key": "q1", "content": "What is your name?", "type": "factual", "requirement": "name", "condition": "", "maxSec": 60},
            {"key": "q2", "content": "Tell me more.", "type": "qualitative", "requirement": "details", "condition": "", "maxSec": 120},
        ],
    }


@pytest.fixture
def resume_interview_id(db, resume_question_set):
    now = datetime.now(timezone.utc)
    res = db.interviews.insert_one(
        {
            "questionSetId": resume_question_set["_id"],
            "status": "in_progress",
            "currentIndex": 0,
            "language": "en-US",
            "ttsVoice": "",
            "createdAt": now,
            "updatedAt": now,
        }
    )
    return str(res.inserted_id)


class TestResumeDoesNotReRender:
    """If last checkpoint message is an AIMessage (question rendered, awaiting user),
    resume should NOT dispatch again."""

    def test_detects_pending_question(self):
        from agent.state_graph import has_pending_question

        messages = [
            SystemMessage(content="You are Anna."),
            HumanMessage(content="begin"),
            AIMessage(content="What is your name?"),
        ]
        assert has_pending_question(messages) is True

    def test_no_pending_when_user_replied(self):
        from agent.state_graph import has_pending_question

        messages = [
            SystemMessage(content="You are Anna."),
            HumanMessage(content="begin"),
            AIMessage(content="What is your name?"),
            HumanMessage(content="My name is John."),
        ]
        assert has_pending_question(messages) is False

    def test_no_pending_on_empty(self):
        from agent.state_graph import has_pending_question

        assert has_pending_question([]) is False


class TestResumePreservesIndex:
    """Index must not be incremented by a resume/re-open."""

    def test_index_unchanged_after_dispatch_without_advance(
        self, db, resume_interview_id, resume_question_set
    ):
        from agent.dispatcher import dispatch

        dispatch(db, resume_interview_id, resume_question_set)
        dispatch(db, resume_interview_id, resume_question_set)

        interview = db.interviews.find_one({"_id": ObjectId(resume_interview_id)})
        assert interview["currentIndex"] == 0
