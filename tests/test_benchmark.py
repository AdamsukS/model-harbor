from collections.abc import Iterator
from typing import Any

from pathlib import Path

from llm_service.benchmark import (
    Measurement,
    SwapWatchdog,
    _append_report,
    calibrate_prompt,
    run_cache_scenario,
)


def test_calibration_converges_within_two_percent() -> None:
    prompt = calibrate_prompt(32_768, lambda text: len(text.split()))

    count = len(prompt.split())
    assert abs(count - 32_768) / 32_768 <= 0.02


def test_cache_scenarios_reuse_only_the_hot_prefix() -> None:
    payloads: list[list[dict[str, Any]]] = []

    def fake_chat(
        base_url: str,
        messages: list[dict[str, Any]],
        *,
        stream: bool,
        max_tokens: int,
        enable_thinking: bool,
        timeout: float,
        extra_body: dict[str, Any],
    ) -> Iterator[dict[str, Any]]:
        payloads.append(messages)
        cached = 900 if len(payloads) == 2 else 0
        return iter(
            [
                {"choices": [{"delta": {"content": "O"}}]},
                {
                    "choices": [],
                    "usage": {
                        "prompt_tokens": 1024,
                        "completion_tokens": 1,
                        "prompt_tokens_details": {"cached_tokens": cached},
                    },
                },
            ]
        )

    records = run_cache_scenario(
        "http://127.0.0.1:8000/v1",
        1024,
        service_pid=42,
        measure=lambda text: len(text.split()),
        chat_fn=fake_chat,
        memory_fn=lambda pid: 1000,
    )

    assert [record.scenario for record in records] == [
        "cold",
        "shared_prefix_hot",
        "different_prefix",
    ]
    assert payloads[0][0] == payloads[1][0]
    assert payloads[0][0] != payloads[2][0]
    assert records[1].cached_tokens == 900
    assert all(record.success for record in records)


def test_measurement_fails_when_usage_is_missing() -> None:
    def fake_chat(*args: object, **kwargs: object) -> Iterator[dict[str, Any]]:
        return iter([{"choices": [{"delta": {"content": "x"}}]}])

    records = run_cache_scenario(
        "http://127.0.0.1:8000/v1",
        64,
        service_pid=42,
        measure=lambda text: len(text.split()),
        chat_fn=fake_chat,
        memory_fn=lambda pid: 1000,
    )

    assert not records[0].success
    assert "usage" in records[0].error
    assert len(records) == 1


def test_disappearing_backend_is_recorded_instead_of_crashing() -> None:
    memory_calls = 0

    def disappearing_memory(pid: int) -> int:
        nonlocal memory_calls
        memory_calls += 1
        if memory_calls == 1:
            return 1000
        raise RuntimeError("process disappeared")

    def failed_chat(*args: object, **kwargs: object) -> Iterator[dict[str, Any]]:
        raise ConnectionError("backend stopped")

    records = run_cache_scenario(
        "http://127.0.0.1:8000/v1",
        64,
        service_pid=42,
        measure=lambda text: len(text.split()),
        chat_fn=failed_chat,
        memory_fn=disappearing_memory,
    )

    assert len(records) == 1
    assert not records[0].success
    assert "backend stopped" in records[0].error


def test_swap_watchdog_triggers_at_one_gibibyte_growth() -> None:
    stopped: list[bool] = []
    watchdog = SwapWatchdog(
        baseline=3 * 1024**3,
        limit=1024**3,
        read_swap=lambda: 4 * 1024**3 + 1,
        on_exceed=lambda: stopped.append(True),
    )

    assert watchdog.poll_once()
    assert watchdog.exceeded
    assert stopped == [True]


def test_markdown_report_identifies_cache_configuration(tmp_path: Path) -> None:
    measurement = Measurement(
        scenario="cold",
        target_tokens=32_768,
        prompt_tokens=32_700,
        cached_tokens=0,
        completion_tokens=2,
        ttft_seconds=10,
        total_seconds=11,
        tokens_per_second=2,
        rss_before=1,
        rss_peak=2,
        rss_after=1,
        success=True,
    )

    path = tmp_path / "report.md"
    _append_report(path, "32k", [measurement], 1, "1200MB")

    report = path.read_text(encoding="utf-8")
    assert "Cache entries" in report
    assert "1200MB" in report
    assert "| 32k | 1 | 1200MB | cold |" in report
