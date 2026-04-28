"""Pymongo client + database accessors.

Sync pymongo throughout this branch — FastAPI will threadpool sync handlers.
Motor / async-pymongo is a Phase 7 consideration if latency budgets demand it.
"""
from functools import lru_cache

from pymongo import MongoClient
from pymongo.database import Database

from agent.config import get_settings


@lru_cache
def get_client() -> MongoClient:
    return MongoClient(get_settings().mongo_uri)


def get_db(name: str | None = None) -> Database:
    """Return the configured Mongo database. Pass `name` to override (tests)."""
    return get_client()[name or get_settings().mongo_db]
