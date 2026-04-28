"""Round-trip tests for the MongoDBSaver checkpointer."""
from typing import Annotated, TypedDict

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from agent.checkpointer import (
    CHECKPOINT_COLLECTION,
    WRITES_COLLECTION,
    build_checkpointer,
)


class _State(TypedDict):
    messages: Annotated[list, add_messages]


def _echo(state: _State) -> dict:
    last = state["messages"][-1]
    return {"messages": [AIMessage(content=f"echo: {last.content}")]}


@pytest.fixture
def checkpointer(mongo_client):
    """A MongoDBSaver pointed at opint_test, collections cleaned around each test."""
    db = mongo_client["opint_test"]
    db[CHECKPOINT_COLLECTION].delete_many({})
    db[WRITES_COLLECTION].delete_many({})
    saver = build_checkpointer(mongo_client, "opint_test")
    yield saver
    db[CHECKPOINT_COLLECTION].delete_many({})
    db[WRITES_COLLECTION].delete_many({})


@pytest.fixture
def stub_graph(checkpointer):
    builder = StateGraph(_State)
    builder.add_node("echo", _echo)
    builder.add_edge(START, "echo")
    builder.add_edge("echo", END)
    return builder.compile(checkpointer=checkpointer)


def _config(thread_id: str) -> dict:
    return {"configurable": {"thread_id": thread_id}}


def test_save_load_round_trip_persists_messages(stub_graph, checkpointer):
    cfg = _config("interview-A")
    stub_graph.invoke({"messages": [HumanMessage(content="hello")]}, config=cfg)

    snapshot = checkpointer.get_tuple(cfg)
    assert snapshot is not None
    saved = snapshot.checkpoint["channel_values"]["messages"]
    assert [m.content for m in saved] == ["hello", "echo: hello"]


def test_two_threads_are_isolated(stub_graph, checkpointer):
    stub_graph.invoke({"messages": [HumanMessage(content="A1")]}, config=_config("thread-A"))
    stub_graph.invoke({"messages": [HumanMessage(content="B1")]}, config=_config("thread-B"))

    a = checkpointer.get_tuple(_config("thread-A"))
    b = checkpointer.get_tuple(_config("thread-B"))
    assert a is not None and b is not None

    a_msgs = [m.content for m in a.checkpoint["channel_values"]["messages"]]
    b_msgs = [m.content for m in b.checkpoint["channel_values"]["messages"]]
    assert "A1" in a_msgs and "B1" not in a_msgs
    assert "B1" in b_msgs and "A1" not in b_msgs


def test_second_invoke_sees_prior_messages(stub_graph):
    cfg = _config("thread-X")
    stub_graph.invoke({"messages": [HumanMessage(content="first")]}, config=cfg)
    stub_graph.invoke({"messages": [HumanMessage(content="second")]}, config=cfg)

    state = stub_graph.get_state(cfg)
    contents = [m.content for m in state.values["messages"]]
    assert contents == [
        "first",
        "echo: first",
        "second",
        "echo: second",
    ]


def test_get_tuple_returns_none_for_unknown_thread(checkpointer):
    assert checkpointer.get_tuple(_config("never-existed")) is None
