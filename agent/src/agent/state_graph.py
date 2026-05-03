"""State-machine graph — Phase 15.1.

Replaces the ReAct graph. The LLM no longer holds the index or calls tools.
The graph deterministically manages: dispatch → render → classify → advance/followup.

Public API: run_open(), run_turn(), has_pending_question().
"""
import time

from langchain_core.messages import AIMessage, HumanMessage, BaseMessage
from pymongo.database import Database

from agent.advance import advance
from agent.classifier import classify
from agent.dispatcher import dispatch
from agent.followup import generate_followup, should_followup


def has_pending_question(messages: list[BaseMessage]) -> bool:
    """True if last message is an AIMessage (question rendered, awaiting user reply)."""
    if not messages:
        return False
    return isinstance(messages[-1], AIMessage)


def _render(renderer_llm, question: dict, language: str | None) -> str:
    """Use the renderer LLM to paraphrase a question in Anna's voice."""
    from langchain_core.messages import HumanMessage as HM, SystemMessage as SM

    sys_content = (
        "You are Anna, a warm research interviewer. "
        "Deliver the following item naturally in your own voice. "
        "Keep it brief and conversational."
    )
    if language and not language.startswith("en"):
        sys_content += f" Speak in {language}."

    user_content = f"Say this: {question['content']}"
    messages = [SM(content=sys_content), HM(content=user_content)]
    result = renderer_llm.invoke(messages)
    if isinstance(result, AIMessage):
        return result.content
    return str(result)


def run_open(
    db: Database,
    interview_id: str,
    question_set: dict,
    renderer_llm,
    **kwargs,
) -> dict:
    """Initialize or resume an interview. Renders non-questions automatically.

    Returns: {"assistant_texts": [str, ...]}
    """
    t0 = time.perf_counter()
    interview = db.interviews.find_one({"_id": __import__("bson").ObjectId(interview_id)})
    language = interview.get("language") if interview else None

    assistant_texts: list[str] = []

    while True:
        result = dispatch(db, interview_id, question_set)

        if result.get("done"):
            assistant_texts.append(result["closing_note"])
            break

        question = result["current_question"]
        rendered = _render(renderer_llm, question, language)
        assistant_texts.append(rendered)

        if result["route"] == "non_question":
            advance(db, interview_id, question_set, question_key=question["key"], extracted={})
        else:
            break

    elapsed_ms = (time.perf_counter() - t0) * 1000
    print(f"[agent] [timing] run_open: {elapsed_ms:.0f}ms")
    return {"assistant_texts": assistant_texts}


def run_turn(
    db: Database,
    interview_id: str,
    question_set: dict,
    user_text: str,
    renderer_llm,
    classifier_llm,
    followup_llm=None,
    **kwargs,
) -> dict:
    """Process a user turn: classify → advance or followup → render next.

    Returns: {"assistant_texts": [str, ...]}
    """
    t0 = time.perf_counter()
    from bson import ObjectId

    interview = db.interviews.find_one({"_id": ObjectId(interview_id)})
    if interview is None:
        return {"assistant_texts": [], "error": "interview not found"}

    language = interview.get("language")
    idx = interview["currentIndex"]
    total = len(question_set["questions"])

    if idx >= total:
        return {"assistant_texts": ["The interview is complete. Thank you."]}

    question = question_set["questions"][idx]
    current_question = {
        "key": question["key"],
        "content": question["content"],
        "type": question["type"],
        "requirement": question.get("requirement", ""),
    }

    followup_count = _get_followup_count(db, interview_id, question["key"])

    classification = classify(
        llm=classifier_llm,
        question=current_question,
        user_response=user_text,
        language=language,
    )

    assistant_texts: list[str] = []

    if classification["satisfied"]:
        advance(
            db, interview_id, question_set,
            question_key=question["key"],
            extracted=classification["extracted"],
        )
        assistant_texts.extend(_render_next(db, interview_id, question_set, renderer_llm, language))
    elif not should_followup(followup_count):
        advance(
            db, interview_id, question_set,
            question_key=question["key"],
            extracted=classification.get("extracted", {}),
            forced=True,
        )
        assistant_texts.extend(_render_next(db, interview_id, question_set, renderer_llm, language))
    else:
        _increment_followup_count(db, interview_id, question["key"])
        if followup_llm is None:
            followup_llm = renderer_llm
        followup_text = generate_followup(
            llm=followup_llm,
            question=current_question,
            missing_fragments=classification["missing_fragments"],
            language=language,
        )
        assistant_texts.append(followup_text)

    elapsed_ms = (time.perf_counter() - t0) * 1000
    print(f"[agent] [timing] run_turn: {elapsed_ms:.0f}ms")
    return {"assistant_texts": assistant_texts}


def _render_next(
    db: Database,
    interview_id: str,
    question_set: dict,
    renderer_llm,
    language: str | None,
) -> list[str]:
    """After advance, render the next question(s). Auto-advance non-questions."""
    texts: list[str] = []
    while True:
        result = dispatch(db, interview_id, question_set)
        if result.get("done"):
            texts.append(result["closing_note"])
            break
        question = result["current_question"]
        rendered = _render(renderer_llm, question, language)
        texts.append(rendered)
        if result["route"] == "non_question":
            advance(db, interview_id, question_set, question_key=question["key"], extracted={})
        else:
            break
    return texts


def _get_followup_count(db: Database, interview_id: str, question_key: str) -> int:
    """Read the followup count for a question from the interview document."""
    from bson import ObjectId
    interview = db.interviews.find_one({"_id": ObjectId(interview_id)})
    if interview is None:
        return 0
    return interview.get("followup_counts", {}).get(question_key, 0)


def _increment_followup_count(db: Database, interview_id: str, question_key: str) -> None:
    """Increment followup count for a question."""
    from bson import ObjectId
    db.interviews.update_one(
        {"_id": ObjectId(interview_id)},
        {"$inc": {f"followup_counts.{question_key}": 1}},
    )
