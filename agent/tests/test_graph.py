"""Graph tests — written cycle-by-cycle, each one driven red then green."""
import pytest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.errors import GraphRecursionError
from pydantic import PrivateAttr

from agent.graph import build_graph


class FakeChatWithTools(GenericFakeChatModel):
    """GenericFakeChatModel + a no-op `bind_tools` so it works inside an agent
    that calls `llm.bind_tools(...)` before invocation. Tool selection is
    scripted via the `messages` iterator, not by the model. Records every
    bind_tools call so tests can assert on the kwargs (e.g. tool_choice)."""

    _bind_calls: list = PrivateAttr(default_factory=list)

    def bind_tools(self, tools, **kwargs):
        self._bind_calls.append({"tools": tools, "kwargs": kwargs})
        return self


# ─────── Cycle 1 ───────


def test_build_graph_returns_compiled_invokable():
    llm = FakeChatWithTools(messages=iter([AIMessage(content="hi")]))
    graph = build_graph(llm=llm, checkpointer=InMemorySaver(), tools=[])

    out = graph.invoke(
        {"messages": [HumanMessage(content="hello")]},
        config={"configurable": {"thread_id": "t1"}},
    )

    msgs = [m for m in out["messages"] if isinstance(m, AIMessage)]
    assert any(m.content == "hi" for m in msgs)


# ─────── Cycle 2 ───────


def test_graph_runs_one_tool_round_trip_and_terminates():
    @tool
    def stub_tool() -> str:
        """A stub tool that always returns a canned string."""
        return "tool_result_42"

    scripted = [
        AIMessage(
            content="",
            tool_calls=[{"name": "stub_tool", "args": {}, "id": "call_1"}],
        ),
        AIMessage(content="final answer"),
    ]
    llm = FakeChatWithTools(messages=iter(scripted))

    graph = build_graph(llm=llm, checkpointer=InMemorySaver(), tools=[stub_tool])

    out = graph.invoke(
        {"messages": [HumanMessage(content="go")]},
        config={"configurable": {"thread_id": "t2"}},
    )

    contents = [m.content for m in out["messages"] if isinstance(m, AIMessage)]
    assert "final answer" in contents

    tool_msgs = [m for m in out["messages"] if isinstance(m, ToolMessage)]
    assert any(m.content == "tool_result_42" for m in tool_msgs)


# ─────── Cycle 3 ───────


def test_graph_does_not_loop_forever_when_llm_keeps_calling_tool():
    @tool
    def stub_tool() -> str:
        """Always returns x."""
        return "x"

    def infinite_tool_calls():
        i = 0
        while True:
            i += 1
            yield AIMessage(
                content="",
                tool_calls=[{"name": "stub_tool", "args": {}, "id": f"c{i}"}],
            )

    llm = FakeChatWithTools(messages=infinite_tool_calls())
    graph = build_graph(llm=llm, checkpointer=InMemorySaver(), tools=[stub_tool])

    with pytest.raises(GraphRecursionError):
        graph.invoke(
            {"messages": [HumanMessage(content="go")]},
            config={"configurable": {"thread_id": "loopy"}, "recursion_limit": 10},
        )


# ─────── Cycle 5 ───────


def test_force_tool_call_after_non_question_tool_result():
    """Mirrors realtime.js:331 — when the prior tool result was a non-question
    item (intro, transition, closing), the next agent invocation must bind
    the LLM with tool_choice forcing the get_next_interview_question tool
    so the model immediately advances to the next item."""

    call_count = {"n": 0}

    @tool
    def get_next_interview_question() -> dict:
        """Returns the next interview item."""
        call_count["n"] += 1
        if call_count["n"] == 1:
            return {"type": "non-question", "key": "intro", "content": "Welcome."}
        return {"type": "qualitative", "key": "q1", "content": "Tell me about your day."}

    scripted = [
        AIMessage(
            content="",
            tool_calls=[{"name": "get_next_interview_question", "args": {}, "id": "c1"}],
        ),
        AIMessage(
            content="",
            tool_calls=[{"name": "get_next_interview_question", "args": {}, "id": "c2"}],
        ),
        AIMessage(content="Tell me about your day."),
    ]
    llm = FakeChatWithTools(messages=iter(scripted))

    graph = build_graph(
        llm=llm,
        checkpointer=InMemorySaver(),
        tools=[get_next_interview_question],
    )
    graph.invoke(
        {"messages": [HumanMessage(content="go")]},
        config={"configurable": {"thread_id": "ftc"}},
    )

    forced = {
        "type": "function",
        "function": {"name": "get_next_interview_question"},
    }

    # Three agent invocations → three bind_tools calls.
    assert len(llm._bind_calls) == 3, f"expected 3 bind_tools calls, got {len(llm._bind_calls)}"
    # Initial: no prior tool message → no force.
    assert llm._bind_calls[0]["kwargs"].get("tool_choice") is None
    # After non-question: must force the tool.
    assert llm._bind_calls[1]["kwargs"].get("tool_choice") == forced
    # After qualitative: free choice again (model can ask follow-up before next tool).
    assert llm._bind_calls[2]["kwargs"].get("tool_choice") is None
