from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]
REPO_ROOT_ENV = REPO_ROOT / ".env"
DEFAULT_PROMPTS_DIR = REPO_ROOT / "prompts" / "anna"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(REPO_ROOT_ENV),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    azure_ai_endpoint: str = Field(default="", alias="AZURE_AI_ENDPOINT")
    azure_ai_key: str = Field(default="", alias="AZURE_AI_KEY")
    azure_ai_deployment: str = Field(default="", alias="AZURE_AI_DEPLOYMENT")
    azure_ai_api_version: str = Field(default="2024-10-21", alias="AZURE_AI_API_VERSION")

    mongo_uri: str = Field(default="mongodb://localhost:27017/opint", alias="MONGO_URI")
    mongo_db: str = Field(default="opint", alias="MONGO_DB")

    py_agent_port: int = Field(default=8001, alias="PY_AGENT_PORT")
    prompts_dir: str = Field(default=str(DEFAULT_PROMPTS_DIR), alias="PROMPTS_DIR")


@lru_cache
def get_settings() -> Settings:
    return Settings()
