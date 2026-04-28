from bson import ObjectId
from fastapi import Depends, FastAPI, HTTPException
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from langgraph.checkpoint.base import BaseCheckpointSaver
from pydantic import BaseModel
from pymongo.database import Database

from agent.checkpointer import get_checkpointer
from agent.config import get_settings
from agent.db import get_db
from agent.graph import build_graph
from agent.langsmith_setup import configure_langsmith
from agent.llm import get_llm
from agent.sessions import system_message_for
from agent.tools import get_next_interview_question as _gnq_impl

# Wire LangSmith tracing at import time (Phase 11.7). No-op if the user
# didn't opt in; never blocks boot if creds are missing.
configure_langsmith(get_settings())

app = FastAPI(title="opint-agent")


@tool
def get_next_interview_question(config: RunnableConfig) -> dict:
    """Fetch the next interview item to deliver. Items have a `type`:
    `non-question` (a statement to *say* — intro, transition, closing — deliver
    in your own voice and call again immediately, do NOT wait for a response);
    `qualitative` or `factual` (a question to *ask* — deliver, wait for the
    participant to answer, optionally one gentle follow-up, then call again).
    Returns {key, content, type, requirement, max_sec, question_number,
    total_questions} or {done: true} when the interview is complete."""
    cfg = config["configurable"]
    return _gnq_impl(cfg["agent_db"], cfg["agent_interview_id"], cfg["agent_question_set"])


def build_app_graph(llm: BaseChatModel, checkpointer: BaseCheckpointSaver):
    return build_graph(llm=llm, checkpointer=checkpointer, tools=[get_next_interview_question])


def get_db_dep() -> Database:
    return get_db()


def get_graph_dep():
    return build_app_graph(llm=get_llm(), checkpointer=get_checkpointer())


class OpenRequest(BaseModel):
    interviewId: str


class TurnRequest(BaseModel):
    interviewId: str
    userText: str


class AgentResponse(BaseModel):
    assistantText: str


OpenResponse = AgentResponse


@app.get("/healthz")
def healthz():
    return {"ok": True, "port": get_settings().py_agent_port}


def _load_or_404(db: Database, interview_id: str) -> tuple[dict, dict]:
    """Fetch the interview + its question set together; 404 if either is missing."""
    interview = db.interviews.find_one({"_id": ObjectId(interview_id)})
    if interview is None:
        raise HTTPException(status_code=404, detail="interview not found")
    question_set = db.questionsets.find_one({"_id": interview["questionSetId"]})
    if question_set is None:
        raise HTTPException(status_code=404, detail="question set not found")
    return interview, question_set


def _config_for(db: Database, interview_id: str, question_set: dict) -> dict:
    return {
        "configurable": {
            "thread_id": interview_id,
            "agent_db": db,
            "agent_interview_id": interview_id,
            "agent_question_set": question_set,
        }
    }


@app.post("/open", response_model=OpenResponse)
def open_interview(
    req: OpenRequest,
    db: Database = Depends(get_db_dep),
    graph=Depends(get_graph_dep),
) -> OpenResponse:
    interview, question_set = _load_or_404(db, req.interviewId)
    config = _config_for(db, req.interviewId, question_set)

    state = graph.get_state(config)
    existing = state.values.get("messages") if state.values else None

    if not existing:
        initial_messages = [system_message_for(interview), HumanMessage(content="begin")]
    else:
        initial_messages = [HumanMessage(content="(resuming session — continue where you left off)")]

    out = _safe_invoke(graph, {"messages": initial_messages}, config)
    return _final_assistant_text(out)


@app.post("/turn", response_model=AgentResponse)
def turn(
    req: TurnRequest,
    db: Database = Depends(get_db_dep),
    graph=Depends(get_graph_dep),
) -> AgentResponse:
    _interview, question_set = _load_or_404(db, req.interviewId)
    config = _config_for(db, req.interviewId, question_set)
    out = _safe_invoke(graph, {"messages": [HumanMessage(content=req.userText)]}, config)
    return _final_assistant_text(out)


def _safe_invoke(graph, input_state: dict, config: dict) -> dict:
    try:
        return graph.invoke(input_state, config=config)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"agent error: {exc}") from exc


def _final_assistant_text(graph_out: dict) -> AgentResponse:
    last_ai = next(
        (m for m in reversed(graph_out["messages"]) if isinstance(m, AIMessage)),
        None,
    )
    if last_ai is None or not last_ai.content:
        raise HTTPException(status_code=502, detail="agent produced no text")
    return AgentResponse(assistantText=last_ai.content)
