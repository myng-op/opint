from agent.prompts import build_system_prompt


def test_no_language_returns_base():
    base = build_system_prompt(None)
    assert "# Language" not in base
    assert len(base) > 0


def test_english_locale_returns_base_unchanged():
    base = build_system_prompt(None)
    assert build_system_prompt("en-US") == base
    assert build_system_prompt("en-GB") == base


def test_finnish_appends_language_block():
    out = build_system_prompt("fi-FI")
    assert out.startswith(build_system_prompt(None))
    assert "# Language" in out
    assert "Finnish" in out


def test_unknown_locale_falls_back_to_raw_tag():
    out = build_system_prompt("xx-YY")
    assert "# Language" in out
    assert "xx-YY" in out


def test_assembled_length_is_sum_plus_separators():
    """Concat order persona → speech → mechanics → guardrails, joined '\\n\\n'."""
    from pathlib import Path

    from agent.prompts import PROMPT_ORDER, prompts_dir

    expected = sum(
        len((Path(prompts_dir()) / f"{name}.md").read_text("utf-8").strip())
        for name in PROMPT_ORDER
    )
    expected += (len(PROMPT_ORDER) - 1) * len("\n\n")

    assert len(build_system_prompt(None)) == expected
