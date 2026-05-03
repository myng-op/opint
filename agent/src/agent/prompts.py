from functools import lru_cache
from pathlib import Path

from agent.config import get_settings

PROMPT_ORDER: tuple[str, ...] = ("persona", "speech", "mechanics", "guardrails")

# BCP-47 language-tag prefix → human-readable name.
# Mirrors the seven supported locales (English, Finnish, Swedish, Chinese,
# Arabic, Somali, Vietnamese) plus a few common European tags. Unknown
# prefixes fall back to the raw locale string.
_LANGUAGE_NAMES: dict[str, str] = {
    "en": "English",
    "fi": "Finnish",
    "sv": "Swedish",
    "zh": "Chinese",
    "ar": "Arabic",
    "so": "Somali",
    "vi": "Vietnamese",
    "de": "German",
    "es": "Spanish",
    "fr": "French",
}


def prompts_dir() -> str:
    return get_settings().prompts_dir


def _load(name: str) -> str:
    return (Path(prompts_dir()) / f"{name}.md").read_text(encoding="utf-8").strip()


@lru_cache
def _system_prompt_base() -> str:
    return "\n\n".join(_load(n) for n in PROMPT_ORDER)


def _language_name(locale: str) -> str:
    prefix = locale.split("-")[0].lower()
    return _LANGUAGE_NAMES.get(prefix, locale)


def build_system_prompt(language: str | None) -> str:
    """Assemble Anna's system prompt; append a language directive for non-English locales.

    Concat order: persona → speech → mechanics → guardrails. The `# Language`
    block is appended only for non-English locales.
    """
    base = _system_prompt_base()
    if not language or language.startswith("en"):
        return base
    name = _language_name(language)
    directive = (
        "\n\n# Language\n\n"
        f"Conduct this entire interview in **{name}**. "
        f"All your speech — greetings, questions, follow-ups, acknowledgements, "
        f"and closing — must be in {name}. "
        f"If the participant switches to another language, gently continue in {name}."
    )
    return base + directive
