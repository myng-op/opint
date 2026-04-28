from datetime import datetime, timezone

import pytest
from bson import ObjectId
from pymongo import MongoClient

from agent.config import get_settings


@pytest.fixture(scope="session")
def mongo_client():
    client = MongoClient(get_settings().mongo_uri, serverSelectionTimeoutMS=2000)
    client.admin.command("ping")
    yield client
    client.close()


@pytest.fixture
def db(mongo_client):
    """Isolated test database — interviews collection cleaned around each test."""
    test_db = mongo_client["opint_test"]
    test_db.interviews.delete_many({})
    yield test_db
    test_db.interviews.delete_many({})


@pytest.fixture
def question_set():
    """A simple 3-item set: 2 questions + 1 non-question, varying maxSec."""
    return {
        "_id": ObjectId(),
        "title": "test_set",
        "questions": [
            {
                "key": "q1",
                "content": "Tell me about your day.",
                "type": "qualitative",
                "requirement": "warmth",
                "condition": "",
                "maxSec": None,
            },
            {
                "key": "q2",
                "content": "What is your name?",
                "type": "factual",
                "requirement": "identity",
                "condition": "",
                "maxSec": 30,
            },
            {
                "key": "q3",
                "content": "Thanks for sharing.",
                "type": "non-question",
                "requirement": "closing",
                "condition": "",
                "maxSec": None,
            },
        ],
    }


@pytest.fixture
def interview_id(db, question_set):
    """Insert a pending interview, return its _id as str."""
    now = datetime.now(timezone.utc)
    res = db.interviews.insert_one(
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
    return str(res.inserted_id)
