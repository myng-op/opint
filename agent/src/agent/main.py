from fastapi import FastAPI

from agent.config import get_settings

app = FastAPI(title="opint-agent")


@app.get("/healthz")
def healthz():
    settings = get_settings()
    return {"ok": True, "port": settings.py_agent_port}
