"""LangGraph ReAct skeleton — Phase 11.4.

The graph is intentionally small: one `agent` node that calls the LLM,
one `tools` ToolNode, and the standard conditional edge that routes to
`tools` when the AIMessage carries tool_calls and to END otherwise.

Force-tool-call mechanic mirrors `server/src/realtime.js:331` — when the
last tool result was a `non-question` item (intro, transition, closing),
the next agent invocation binds the LLM with `tool_choice` forcing the
get_next_interview_question tool. Without this, the model is free to
loiter on the non-question item and won't auto-advance to the next.
"""
import json
from typing import Annotated, Any, TypedDict

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import ToolMessage
from langchain_core.tools import BaseTool
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode, tools_condition

FORCE_TOOL_NAME = "get_next_interview_question"


class State(TypedDict):
    messages: Annotated[list, add_messages]


def _last_tool_message(messages: list) -> ToolMessage | None:
    for m in reversed(messages):
        if isinstance(m, ToolMessage):
            return m
    return None


def _should_force_tool_call(messages: list) -> bool:
    last = _last_tool_message(messages)
    if last is None:
        return False
    raw: Any = last.content
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return False
    return isinstance(raw, dict) and raw.get("type") == "non-question"


def build_graph(
    llm: BaseChatModel,
    checkpointer: BaseCheckpointSaver,
    tools: list[BaseTool],
):
    forced = {"type": "function", "function": {"name": FORCE_TOOL_NAME}}

    def agent(state: State) -> dict:
        if not tools:
            bound = llm
        elif _should_force_tool_call(state["messages"]):
            bound = llm.bind_tools(tools, tool_choice=forced)
        else:
            bound = llm.bind_tools(tools)
        return {"messages": [bound.invoke(state["messages"])]}

    builder = StateGraph(State)
    builder.add_node("agent", agent)
    builder.add_edge(START, "agent")

    if tools:
        builder.add_node("tools", ToolNode(tools))
        builder.add_conditional_edges("agent", tools_condition)
        builder.add_edge("tools", "agent")
    else:
        builder.add_edge("agent", END)

    return builder.compile(checkpointer=checkpointer)
