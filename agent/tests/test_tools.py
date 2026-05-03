"""Tests for the interview-state tool: state transitions + wire shape."""
from datetime import datetime

from bson import ObjectId

from agent.dispatch import handle_tool_call
from agent.tools import get_next_interview_question


def test_returns_error_when_interview_not_found(db, question_set):
    out = get_next_interview_question(db, str(ObjectId()), question_set)
    assert out == {"error": "interview not found"}


def test_pending_first_question_flips_status_and_stamps_startedAt(
    db, interview_id, question_set
):
    out = get_next_interview_question(db, interview_id, question_set)

    assert out == {
        "key": "q1",
        "content": "Tell me about your day.",
        "type": "qualitative",
        "requirement": "warmth",
        "max_sec": None,
        "question_number": 1,
        "total_questions": 3,
    }

    interview = db.interviews.find_one({"_id": ObjectId(interview_id)})
    assert interview["status"] == "in_progress"
    assert isinstance(interview["startedAt"], datetime)
    assert interview["currentIndex"] == 1


def test_in_progress_bumps_index_only(db, interview_id, question_set):
    get_next_interview_question(db, interview_id, question_set)
    started_at = db.interviews.find_one({"_id": ObjectId(interview_id)})["startedAt"]

    out = get_next_interview_question(db, interview_id, question_set)
    assert out["key"] == "q2"
    assert out["max_sec"] == 30
    assert out["question_number"] == 2
    assert out["total_questions"] == 3

    interview = db.interviews.find_one({"_id": ObjectId(interview_id)})
    assert interview["status"] == "in_progress"
    assert interview["currentIndex"] == 2
    assert interview["startedAt"] == started_at  # not re-stamped


def test_exhausted_returns_done_and_marks_completed(db, interview_id, question_set):
    for _ in range(len(question_set["questions"])):
        get_next_interview_question(db, interview_id, question_set)

    out = get_next_interview_question(db, interview_id, question_set)
    assert out["done"] is True
    assert "closing_note" in out
    assert "Thank the participant" in out["closing_note"]

    interview = db.interviews.find_one({"_id": ObjectId(interview_id)})
    assert interview["status"] == "completed"
    assert isinstance(interview["endedAt"], datetime)


def test_completed_recall_is_idempotent(db, interview_id, question_set):
    for _ in range(len(question_set["questions"])):
        get_next_interview_question(db, interview_id, question_set)
    get_next_interview_question(db, interview_id, question_set)

    ended_first = db.interviews.find_one({"_id": ObjectId(interview_id)})["endedAt"]

    out = get_next_interview_question(db, interview_id, question_set)
    assert out["done"] is True

    interview = db.interviews.find_one({"_id": ObjectId(interview_id)})
    assert interview["status"] == "completed"
    assert interview["endedAt"] == ended_first  # not re-stamped


def test_dispatch_routes_known_tool(db, interview_id, question_set):
    out = handle_tool_call(
        "get_next_interview_question", {}, db, interview_id, question_set
    )
    assert out["key"] == "q1"


def test_dispatch_returns_error_for_unknown_tool(db, interview_id, question_set):
    out = handle_tool_call("not_a_tool", {}, db, interview_id, question_set)
    assert out == {"error": "unknown tool: not_a_tool"}
