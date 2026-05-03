"""Advance node — the ONLY place that increments currentIndex.

Writes extracted data to interview.responses[question_key].
Resets requirement_status for the next question.
"""
from datetime import datetime, timezone

from bson import ObjectId
from pymongo.database import Database


def _now() -> datetime:
    return datetime.now(timezone.utc)


def advance(
    db: Database,
    interview_id: str,
    question_set: dict,
    question_key: str,
    extracted: dict,
    forced: bool = False,
) -> None:
    """Increment currentIndex and persist extracted data.

    Args:
        db: Mongo database
        interview_id: interview ObjectId as string
        question_set: the full question set dict
        question_key: key of the question being advanced past
        extracted: accumulated extracted data for this question
        forced: True if advancing due to followup cap (marks unsatisfied)
    """
    interviews = db["interviews"]
    oid = ObjectId(interview_id)
    interview = interviews.find_one({"_id": oid})
    if interview is None:
        return

    idx = interview["currentIndex"]
    total = len(question_set["questions"])
    q = question_set["questions"][idx] if idx < total else None

    is_non_question = q is not None and q["type"] == "non-question"

    update: dict = {
        "currentIndex": idx + 1,
        "updatedAt": _now(),
    }

    if not is_non_question and question_key:
        response_data = {
            "extracted": extracted,
            "satisfied": not forced and bool(extracted),
        }
        update[f"responses.{question_key}"] = response_data

    interviews.update_one({"_id": oid}, {"$set": update})

    if forced:
        print(f"[agent] [warning] forced advance past {question_key} — followup cap reached")
