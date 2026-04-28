"""FastAPI endpoint tests (Phase 11.5) — strict TDD red→green per cycle."""
from datetime import datetime, timezone

import pytest
from bson import ObjectId
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langgraph.checkpoint.memory import InMemorySaver

from agent.graph import build_graph
from agent.main import app, get_db_dep, get_graph_dep
from tests.test_graph import FakeChatWithTools


@pytest.fixture
def endpoint_db(mongo_client):
    """Test DB with both `interviews` and `questionsets` collections cleaned."""
    db = mongo_client["opint_test"]
    db.interviews.delete_many({})
    db.questionsets.delete_many({})
    yield db
    db.interviews.delete_many({})
    db.questionsets.delete_many({})


@pytest.fixture
def inserted_setup(endpoint_db, question_set):
    """Inserts question_set + a pending interview; returns (db, interview_id)."""
    endpoint_db.questionsets.insert_one(question_set)
    now = datetime.now(timezone.utc)
    res = endpoint_db.interviews.insert_one(
        {
            "questionSetId": question_set["_id"],
            "status": "pending",
            "currentIndex": 0,
            "language": "",
            "ttsVoice": "",
            "createdAt": now,
            "updatedAt": now,
        }
    )
    return endpoint_db, str(res.inserted_id)


@pytest.fixture
def client_factory(endpoint_db):
    """Builds a TestClient with `get_db_dep` and `get_graph_dep` overridden.

    Caller passes the scripted fake LLM messages; we wire a graph using
    InMemorySaver (so resume tests within one fixture invocation work)."""

    def _make(scripted_messages):
        llm = FakeChatWithTools(messages=iter(scripted_messages))
        graph = build_graph(llm=llm, checkpointer=InMemorySaver(), tools=[])

        app.dependency_overrides[get_db_dep] = lambda: endpoint_db
        app.dependency_overrides[get_graph_dep] = lambda: graph
        client = TestClient(app)
        return client, llm, graph

    yield _make
    app.dependency_overrides.clear()


# ─────── Cycle 1 ───────


def test_open_fresh_returns_greeting_text(inserted_setup, client_factory):
    _db, interview_id = inserted_setup
    client, _, _ = client_factory([AIMessage(content="Hello, I'm Anna.")])

    resp = client.post("/open", json={"interviewId": interview_id})

    assert resp.status_code == 200
    assert resp.json() == {"assistantText": "Hello, I'm Anna."}


# ─────── Cycle 2 ───────


def test_open_seeds_system_prompt_once_only(inserted_setup, client_factory):
    """Fresh thread → SystemMessage prepended; resume → no second SystemMessage."""
    _db, interview_id = inserted_setup
    client, _, graph = client_factory(
        [AIMessage(content="hi"), AIMessage(content="welcome back")]
    )

    client.post("/open", json={"interviewId": interview_id})
    client.post("/open", json={"interviewId": interview_id})

    state = graph.get_state({"configurable": {"thread_id": interview_id}})
    system_msgs = [m for m in state.values["messages"] if isinstance(m, SystemMessage)]
    assert len(system_msgs) == 1, (
        f"expected exactly 1 SystemMessage in checkpointed state, got {len(system_msgs)}"
    )


# ─────── Cycle 3 ───────


def test_turn_appends_user_text_and_returns_assistant(inserted_setup, client_factory):
    _db, interview_id = inserted_setup
    client, _, graph = client_factory(
        [AIMessage(content="hi"), AIMessage(content="thanks for sharing")]
    )

    client.post("/open", json={"interviewId": interview_id})
    resp = client.post(
        "/turn",
        json={"interviewId": interview_id, "userText": "I'm well."},
    )

    assert resp.status_code == 200
    assert resp.json() == {"assistantText": "thanks for sharing"}

    state = graph.get_state({"configurable": {"thread_id": interview_id}})
    user_msgs = [
        m for m in state.values["messages"]
        if isinstance(m, HumanMessage) and m.content == "I'm well."
    ]
    assert len(user_msgs) == 1


# ─────── Cycle 4 ───────


def test_turn_returns_502_when_graph_invocation_raises(inserted_setup, endpoint_db):
    """If the agent graph raises (LLM HTTP failure, tool exception, etc.) Node
    needs a 5xx with structured body so it can surface response.error on
    the WS rather than masking the failure as a successful response."""
    _db, interview_id = inserted_setup

    class _BoomGraph:
        def get_state(self, config):
            class _S:
                values: dict = {}
            return _S()

        def invoke(self, *args, **kwargs):
            raise RuntimeError("LLM upstream boom")

    app.dependency_overrides[get_db_dep] = lambda: endpoint_db
    app.dependency_overrides[get_graph_dep] = lambda: _BoomGraph()
    try:
        client = TestClient(app)
        resp = client.post(
            "/turn",
            json={"interviewId": interview_id, "userText": "hello"},
        )
        assert resp.status_code == 502
        assert "detail" in resp.json()
    finally:
        app.dependency_overrides.clear()


# ─────── Regression locks (already-green from impl + Pydantic) ───────


def test_open_returns_404_for_unknown_interview(client_factory):
    client, _, _ = client_factory([AIMessage(content="never reached")])
    resp = client.post("/open", json={"interviewId": str(ObjectId())})
    assert resp.status_code == 404


def test_open_returns_422_for_malformed_body(client_factory):
    client, _, _ = client_factory([AIMessage(content="x")])
    resp = client.post("/open", json={})  # missing interviewId
    assert resp.status_code == 422


def test_turn_returns_404_for_unknown_interview(client_factory):
    client, _, _ = client_factory([AIMessage(content="x")])
    resp = client.post(
        "/turn", json={"interviewId": str(ObjectId()), "userText": "hi"}
    )
    assert resp.status_code == 404


def test_open_returns_502_when_graph_invocation_raises(inserted_setup, endpoint_db):
    _db, interview_id = inserted_setup

    class _BoomGraph:
        def get_state(self, config):
            class _S:
                values: dict = {}
            return _S()

        def invoke(self, *args, **kwargs):
            raise RuntimeError("LLM boom on open")

    app.dependency_overrides[get_db_dep] = lambda: endpoint_db
    app.dependency_overrides[get_graph_dep] = lambda: _BoomGraph()
    try:
        client = TestClient(app)
        resp = client.post("/open", json={"interviewId": interview_id})
        assert resp.status_code == 502
        assert "detail" in resp.json()
    finally:
        app.dependency_overrides.clear()


# ─────── Cycle 6 — real tool wiring ───────


def test_open_invokes_real_tool_and_advances_interview(inserted_setup, endpoint_db):
    """The /open endpoint must wire `get_next_interview_question` into the
    graph with per-request config (db, interview_id, question_set), so the
    tool actually mutates Mongo state when the LLM calls it."""
    from agent.main import build_app_graph

    _db, interview_id = inserted_setup

    scripted = [
        AIMessage(
            content="",
            tool_calls=[{"name": "get_next_interview_question", "args": {}, "id": "c1"}],
        ),
        AIMessage(content="Welcome."),
    ]
    llm = FakeChatWithTools(messages=iter(scripted))
    graph = build_app_graph(llm=llm, checkpointer=InMemorySaver())

    app.dependency_overrides[get_db_dep] = lambda: endpoint_db
    app.dependency_overrides[get_graph_dep] = lambda: graph
    try:
        client = TestClient(app)
        resp = client.post("/open", json={"interviewId": interview_id})
        assert resp.status_code == 200
        assert resp.json() == {"assistantText": "Welcome."}
    finally:
        app.dependency_overrides.clear()

    interview = endpoint_db.interviews.find_one({"_id": ObjectId(interview_id)})
    assert interview["status"] == "in_progress"
    assert interview["currentIndex"] == 1
