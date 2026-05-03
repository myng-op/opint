"""Classifier node — structured output to evaluate if requirement is met.

English judgment prompt regardless of interview language.
Post-check: satisfied is forced False if missing_fragments is non-empty.
"""
from langchain_core.messages import HumanMessage, SystemMessage

CLASSIFIER_SYSTEM_PROMPT = """You are a strict requirement evaluator for a research interview.

Given a question's requirement and the participant's response, determine:
1. Whether ALL parts of the requirement have been satisfied
2. Which specific fragments are still missing (if any)
3. What information was successfully extracted

Respond with a JSON object containing:
- satisfied: boolean (true only if ALL requirement parts are covered)
- missing_fragments: list of strings (specific parts not yet answered)
- extracted: dict mapping requirement parts to the participant's answers

Be precise. If the requirement says "name, age, gender" and only name is given, mark age and gender as missing."""


def build_classifier_prompt(
    question: dict,
    user_response: str,
    language: str | None,
) -> list:
    user_content = (
        f"Question requirement: {question['requirement']}\n"
        f"Question asked: {question['content']}\n"
        f"Participant's response (verbatim): \"{user_response}\"\n\n"
        f"Assess whether the requirement is fully satisfied."
    )
    if language and not language.startswith("en"):
        user_content += (
            f"\n\nNote: The interview is in {language}. "
            f"The response is quoted verbatim in the original language. "
            f"Evaluate the semantic content regardless of language."
        )

    return [
        SystemMessage(content=CLASSIFIER_SYSTEM_PROMPT),
        HumanMessage(content=user_content),
    ]


def classify(
    llm,
    question: dict,
    user_response: str,
    language: str | None,
) -> dict:
    """Classify whether a user's response satisfies the question's requirement.

    Returns dict with: satisfied, missing_fragments, extracted.
    Post-check: if missing_fragments is non-empty, satisfied is forced False.
    """
    messages = build_classifier_prompt(question, user_response, language)
    result = llm.invoke(messages)

    if isinstance(result, dict):
        output = result
    else:
        output = result if isinstance(result, dict) else result

    if len(output.get("missing_fragments", [])) > 0:
        output["satisfied"] = False

    return output
