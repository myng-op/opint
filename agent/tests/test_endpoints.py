"""FastAPI endpoint tests — Phase 15.1 state-machine graph.

Tests the /open and /turn endpoints against the new deterministic state machine.
Mocks the LLM at the dependency level (renderer + classifier).
"""
from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from bson import ObjectId
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage

from agent.main import app, get_db_dep


@pytest.fixture
def endpoint_db(mongo_client):
    db = mongo_client["opint_test"]
    db.interviews.delete_many({})
    db.questionsets.delete_many({})
    yield db
    db.interviews.delete_many({})
    db.questionsets.delete_many({})


@pytest.fixture
def inserted_setup(endpoint_db, question_set):
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


class FakeLLM:
    """Returns scripted AIMessage responses in order."""
    def __init__(self, responses: list[str]):
        self._responses = responses
        self._idx = 0

    def invoke(self, messages):
        text = self._responses[self._idx % len(self._responses)]
        self._idx += 1
        return AIMessage(content=text)

    def with_structured_output(self, schema):
        return self


class FakeClassifierLLM:
    """Returns scripted classification dicts."""
    def __init__(self, results: list[dict]):
        self._results = results
        self._idx = 0

    def invoke(self, messages):
        result = self._results[self._idx % len(self._results)]
        self._idx += 1
        return result


@pytest.fixture
def client(endpoint_db):
    app.dependency_overrides[get_db_dep] = lambda: endpoint_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_open_fresh_returns_greeting_text(inserted_setup, endpoint_db):
    _db, interview_id = inserted_setup
    fake_llm = FakeLLM(["Welcome to the interview!", "Tell me about your day."])

    app.dependency_overrides[get_db_dep] = lambda: endpoint_db
    with patch("agent.main.get_llm", return_value=fake_llm):
        client = TestClient(app)
        resp = client.post("/open", json={"interviewId": interview_id})

    assert resp.status_code == 200
    body = resp.json()
    assert "assistantText" in body
    assert len(body["assistantText"]) > 0
    app.dependency_overrides.clear()


def test_open_seeds_system_prompt_once_only(inserted_setup, endpoint_db):
    """Multiple /open calls to a question (not non-question) don't re-advance."""
    _db, interview_id = inserted_setup
    fake_llm = FakeLLM(["Tell me about your day.", "Tell me about your day."])

    app.dependency_overrides[get_db_dep] = lambda: endpoint_db
    with patch("agent.main.get_llm", return_value=fake_llm):
        client = TestClient(app)
        client.post("/open", json={"interviewId": interview_id})
        resp2 = client.post("/open", json={"interviewId": interview_id})

    assert resp2.status_code == 200
    interview = endpoint_db.interviews.find_one({"_id": ObjectId(interview_id)})
    # Index stays at 0 — first item is a question, no auto-advance
    assert interview["currentIndex"] == 0
    app.dependency_overrides.clear()


def test_turn_appends_user_text_and_returns_assistant(inserted_setup, endpoint_db):
    _db, interview_id = inserted_setup
    renderer = FakeLLM(["Welcome!", "Tell me about your day.", "What is your name?"])
    classifier = FakeClassifierLLM([
        {"satisfied": True, "missing_fragments": [], "extracted": {"warmth": "I'm well"}},
    ])

    app.dependency_overrides[get_db_dep] = lambda: endpoint_db
    with patch("agent.main.get_llm") as mock_llm:
        mock_llm.return_value = renderer
        mock_llm.return_value.with_structured_output = lambda schema: classifier
        client = TestClient(app)
        client.post("/open", json={"interviewId": interview_id})
        resp = client.post(
            "/turn",
            json={"interviewId": interview_id, "userText": "I'm well."},
        )

    assert resp.status_code == 200
    assert "assistantText" in resp.json()
    app.dependency_overrides.clear()


def test_turn_returns_502_when_graph_invocation_raises(inserted_setup, endpoint_db):
    _db, interview_id = inserted_setup
    fake_llm = FakeLLM(["Tell me about your day."])

    app.dependency_overrides[get_db_dep] = lambda: endpoint_db
    with patch("agent.main.get_llm", return_value=fake_llm):
        client = TestClient(app)
        # First open to establish state
        client.post("/open", json={"interviewId": interview_id})

    # Now patch run_turn to raise
    with patch("agent.main.run_turn", side_effect=RuntimeError("LLM upstream boom")):
        with patch("agent.main.get_llm", return_value=fake_llm):
            client = TestClient(app)
            resp = client.post(
                "/turn",
                json={"interviewId": interview_id, "userText": "hello"},
            )
    assert resp.status_code == 502
    assert "detail" in resp.json()
    app.dependency_overrides.clear()


def test_open_returns_404_for_unknown_interview(endpoint_db):
    app.dependency_overrides[get_db_dep] = lambda: endpoint_db
    client = TestClient(app)
    resp = client.post("/open", json={"interviewId": str(ObjectId())})
    assert resp.status_code == 404
    app.dependency_overrides.clear()


def test_open_returns_422_for_malformed_body(endpoint_db):
    app.dependency_overrides[get_db_dep] = lambda: endpoint_db
    client = TestClient(app)
    resp = client.post("/open", json={})
    assert resp.status_code == 422
    app.dependency_overrides.clear()


def test_turn_returns_404_for_unknown_interview(endpoint_db):
    app.dependency_overrides[get_db_dep] = lambda: endpoint_db
    client = TestClient(app)
    resp = client.post(
        "/turn", json={"interviewId": str(ObjectId()), "userText": "hi"}
    )
    assert resp.status_code == 404
    app.dependency_overrides.clear()


def test_open_returns_502_when_llm_raises(inserted_setup, endpoint_db):
    _db, interview_id = inserted_setup
    app.dependency_overrides[get_db_dep] = lambda: endpoint_db
    with patch("agent.main.run_open", side_effect=RuntimeError("LLM boom")):
        with patch("agent.main.get_llm", return_value=FakeLLM(["x"])):
            client = TestClient(app)
            resp = client.post("/open", json={"interviewId": interview_id})
    assert resp.status_code == 502
    assert "detail" in resp.json()
    app.dependency_overrides.clear()


def test_open_invokes_real_tool_and_advances_interview(inserted_setup, endpoint_db):
    """The /open endpoint dispatches and renders the first question, flipping status."""
    _db, interview_id = inserted_setup
    fake_llm = FakeLLM(["Tell me about your day."])

    app.dependency_overrides[get_db_dep] = lambda: endpoint_db
    with patch("agent.main.get_llm", return_value=fake_llm):
        client = TestClient(app)
        resp = client.post("/open", json={"interviewId": interview_id})

    assert resp.status_code == 200

    interview = endpoint_db.interviews.find_one({"_id": ObjectId(interview_id)})
    assert interview["status"] == "in_progress"
    # First item is qualitative — no auto-advance, index stays at 0
    assert interview["currentIndex"] == 0
    app.dependency_overrides.clear()


def test_resume_preserves_state_and_does_not_replay_questions(
    inserted_setup, endpoint_db
):
    """Resume after advancing: /open doesn't re-advance past already-asked question."""
    _db, interview_id = inserted_setup
    renderer = FakeLLM([
        "Tell me about your day.",  # first /open (q1 rendered)
        "What is your name?",  # after turn advances to q2
        "What is your name?",  # second /open (resume, re-renders q2)
    ])
    classifier = FakeClassifierLLM([
        {"satisfied": True, "missing_fragments": [], "extracted": {"warmth": "good day"}},
    ])

    app.dependency_overrides[get_db_dep] = lambda: endpoint_db
    with patch("agent.main.get_llm") as mock_llm:
        mock_llm.return_value = renderer
        mock_llm.return_value.with_structured_output = lambda schema: classifier
        client = TestClient(app)

        # First open: renders q1 (qualitative), index stays at 0
        client.post("/open", json={"interviewId": interview_id})

        interview = endpoint_db.interviews.find_one({"_id": ObjectId(interview_id)})
        assert interview["currentIndex"] == 0

        # Answer q1 — advances to q2 (index becomes 1)
        client.post("/turn", json={"interviewId": interview_id, "userText": "Good day"})

        interview = endpoint_db.interviews.find_one({"_id": ObjectId(interview_id)})
        assert interview["currentIndex"] == 1

        # Resume /open — should NOT re-advance
        client.post("/open", json={"interviewId": interview_id})

        interview = endpoint_db.interviews.find_one({"_id": ObjectId(interview_id)})
        assert interview["currentIndex"] == 1  # unchanged
    app.dependency_overrides.clear()
