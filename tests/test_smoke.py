from collections.abc import Iterator
from typing import Any

import pytest

import llm_service.smoke as smoke
from llm_service.smoke import run_smoke


def test_smoke_covers_protocol_and_five_waiting_clients(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(smoke, "list_models", lambda base_url: [{"id": "default_model"}])

    def fake_chat(
        base_url: str,
        messages: list[dict[str, Any]],
        *,
        stream: bool = False,
        tools: list[dict[str, Any]] | None = None,
        max_tokens: int = 64,
        enable_thinking: bool = False,
        timeout: float = 300,
    ) -> dict[str, Any] | Iterator[dict[str, Any]]:
        if stream:
            return iter(
                [
                    {"choices": [{"delta": {"content": "流"}}]},
                    {"choices": [{"delta": {"content": "式"}}]},
                ]
            )
        if tools:
            return {
                "choices": [
                    {
                        "message": {
                            "tool_calls": [
                                {
                                    "type": "function",
                                    "function": {
                                        "name": "get_weather",
                                        "arguments": '{"city":"北京"}',
                                    },
                                }
                            ]
                        }
                    }
                ]
            }
        return {"choices": [{"message": {"content": "OK"}}]}

    monkeypatch.setattr(smoke, "chat", fake_chat)

    report = run_smoke("http://127.0.0.1:8000/v1", concurrency=5)

    assert report.passed
    assert [result.name for result in report.results] == [
        "models",
        "chat",
        "stream",
        "multi_turn",
        "tool_call",
        "concurrency_5",
    ]


def test_smoke_reports_a_scenario_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(smoke, "list_models", lambda base_url: [])

    report = run_smoke("http://127.0.0.1:8000/v1", concurrency=1)

    assert not report.passed
    assert report.results[0].name == "models"
    assert "no models" in report.results[0].detail
