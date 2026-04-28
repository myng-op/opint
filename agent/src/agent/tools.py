"""Python port of `server/src/realtime/tools.js` — bit-exact parity.

Node uses Mongoose; Py uses raw pymongo (no ODM). The wire format returned
to the LLM matches Node exactly (snake_case keys, identical state-mutation
semantics on the `interviews` document).
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


def get_next_interview_question(
    db: Database,
    interview_id: str,
    question_set: dict,
) -> dict:
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
        return {"done": True, "closing_note": CLOSING_NOTE}

    q = question_set["questions"][idx]

    set_fields: dict = {"currentIndex": idx + 1, "updatedAt": _now()}
    if interview["status"] == "pending":
        set_fields["status"] = "in_progress"
        set_fields["startedAt"] = _now()
    interviews.update_one({"_id": oid}, {"$set": set_fields})

    return {
        "key": q["key"],
        "content": q["content"],
        "type": q["type"],
        "requirement": q["requirement"],
        "max_sec": q.get("maxSec"),
        "question_number": idx + 1,
        "total_questions": total,
    }
