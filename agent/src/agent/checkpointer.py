"""MongoDB checkpointer factory for the LangGraph agent.

Persists graph state per `thread_id` (= interviewId) so a WS drop
mid-interview can resume from the last checkpoint via /open. Reuses the
same Mongo client as the rest of the agent; lives in a dedicated
collection so it can't collide with `interviews` or `questionsets`.
"""
from functools import lru_cache

from langgraph.checkpoint.mongodb import MongoDBSaver
from pymongo import MongoClient

from agent.config import get_settings
from agent.db import get_client

CHECKPOINT_COLLECTION = "agent_checkpoints"
WRITES_COLLECTION = "agent_checkpoint_writes"


def build_checkpointer(
    client: MongoClient,
    db_name: str,
) -> MongoDBSaver:
    return MongoDBSaver(
        client=client,
        db_name=db_name,
        checkpoint_collection_name=CHECKPOINT_COLLECTION,
        writes_collection_name=WRITES_COLLECTION,
    )


@lru_cache
def get_checkpointer() -> MongoDBSaver:
    return build_checkpointer(get_client(), get_settings().mongo_db)
