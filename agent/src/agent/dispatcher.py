"""Dispatcher node — reads currentIndex, fetches question, routes.

NEVER increments the index. Only `advance` does that.
Flips pending → in_progress on first dispatch.
"""
from datetime import datetime, timezone

from bson import ObjectId
from pymongo.database import Database

CLOSING_NOTE = (
    "Thank the participant warmly for sharing their story. "
    "Their contribution is valuable to this research."
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def dispatch(db: Database, interview_id: str, question_set: dict) -> dict:
    """Read currentIndex, fetch question, route based on type.

    Returns:
        dict with keys:
            - route: "non_question" | "question" | "done"
            - current_question: dict (if not done)
            - done: True (if exhausted)
            - closing_note: str (if done)
    """
    interviews = db["interviews"]
    oid = ObjectId(interview_id)
    interview = interviews.find_one({"_id": oid})
    if interview is None:
        return {"error": "interview not found"}

    total = len(question_set["questions"])
    idx = interview["currentIndex"]

    if idx >= total:
        if interview["status"] != "completed":
            interviews.update_one(
                {"_id": oid},
                {"$set": {"status": "completed", "endedAt": _now(), "updatedAt": _now()}},
            )
        return {"done": True, "closing_note": CLOSING_NOTE, "route": "done"}

    q = question_set["questions"][idx]

    if interview["status"] == "pending":
        interviews.update_one(
            {"_id": oid},
            {"$set": {"status": "in_progress", "startedAt": _now(), "updatedAt": _now()}},
        )

    current_question = {
        "key": q["key"],
        "content": q["content"],
        "type": q["type"],
        "requirement": q.get("requirement", ""),
        "max_sec": q.get("maxSec"),
        "question_number": idx + 1,
        "total_questions": total,
    }

    route = "non_question" if q["type"] == "non-question" else "question"
    return {"current_question": current_question, "route": route}
