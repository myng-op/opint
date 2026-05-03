"""FastAPI endpoints — Phase 15.1 state-machine graph.

/open and /turn now drive the deterministic state machine (dispatcher →
classifier → advance/followup) instead of the ReAct tool-calling loop.
External contract unchanged: same request/response shapes.
"""
from bson import ObjectId
from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel
from pymongo.database import Database

from agent.config import get_settings
from agent.db import get_db
from agent.llm import get_llm
from agent.state_graph import run_open, run_turn

app = FastAPI(title="opint-agent")


def get_db_dep() -> Database:
    return get_db()


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
    interview = db.interviews.find_one({"_id": ObjectId(interview_id)})
    if interview is None:
        raise HTTPException(status_code=404, detail="interview not found")
    question_set = db.questionsets.find_one({"_id": interview["questionSetId"]})
    if question_set is None:
        raise HTTPException(status_code=404, detail="question set not found")
    return interview, question_set


@app.post("/open", response_model=OpenResponse)
def open_interview(
    req: OpenRequest,
    db: Database = Depends(get_db_dep),
) -> OpenResponse:
    _interview, question_set = _load_or_404(db, req.interviewId)
    llm = get_llm()
    try:
        result = run_open(
            db=db,
            interview_id=req.interviewId,
            question_set=question_set,
            renderer_llm=llm,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"agent error: {exc}") from exc

    texts = result.get("assistant_texts", [])
    if not texts:
        raise HTTPException(status_code=502, detail="agent produced no text")
    return AgentResponse(assistantText="\n\n".join(texts))


@app.post("/turn", response_model=AgentResponse)
def turn(
    req: TurnRequest,
    db: Database = Depends(get_db_dep),
) -> AgentResponse:
    _interview, question_set = _load_or_404(db, req.interviewId)
    llm = get_llm()
    classifier_llm = llm.with_structured_output({
        "type": "object",
        "properties": {
            "satisfied": {"type": "boolean"},
            "missing_fragments": {"type": "array", "items": {"type": "string"}},
            "extracted": {"type": "object"},
        },
        "required": ["satisfied", "missing_fragments", "extracted"],
    })
    try:
        result = run_turn(
            db=db,
            interview_id=req.interviewId,
            question_set=question_set,
            user_text=req.userText,
            renderer_llm=llm,
            classifier_llm=classifier_llm,
            followup_llm=llm,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"agent error: {exc}") from exc

    texts = result.get("assistant_texts", [])
    if not texts:
        raise HTTPException(status_code=502, detail="agent produced no text")
    return AgentResponse(assistantText="\n\n".join(texts))
