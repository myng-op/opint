"""Tool-call dispatcher. Mirrors `server/src/realtime/tools.js` handleToolCall."""
from pymongo.database import Database

from agent.tools import get_next_interview_question


def handle_tool_call(
    name: str,
    args: dict,
    db: Database,
    interview_id: str,
    question_set: dict,
) -> dict:
    if name == "get_next_interview_question":
        return get_next_interview_question(db, interview_id, question_set)
    return {"error": f"unknown tool: {name}"}
