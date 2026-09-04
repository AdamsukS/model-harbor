"""Protocol-level smoke tests against a running inference backend."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
import json
import time
from collections.abc import Callable, Iterator
from typing import Any

from llm_service.client import chat, list_models


@dataclass(frozen=True, slots=True)
class ScenarioResult:
    name: str
    passed: bool
    seconds: float
    detail: str


@dataclass(frozen=True, slots=True)
class SmokeReport:
    base_url: str
    results: list[ScenarioResult]

    @property
    def passed(self) -> bool:
        return all(result.passed for result in self.results)

    def to_dict(self) -> dict[str, Any]:
        return {
            "base_url": self.base_url,
            "passed": self.passed,
            "results": [asdict(result) for result in self.results],
        }


def _scenario(name: str, action: Callable[[], str]) -> ScenarioResult:
    started = time.perf_counter()
    try:
        detail = action()
        return ScenarioResult(name, True, time.perf_counter() - started, detail)
    except Exception as exc:
        return ScenarioResult(
            name,
            False,
            time.perf_counter() - started,
            f"{type(exc).__name__}: {exc}",
        )


def _message_content(response: dict[str, Any]) -> str:
    message = response["choices"][0]["message"]
    content = message.get("content", "")
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("response contained no assistant content")
    return content.strip()


def run_smoke(base_url: str, concurrency: int = 5) -> SmokeReport:
    """Run deterministic protocol checks, including queued client pressure."""
    results: list[ScenarioResult] = []

    def models_action() -> str:
        models = list_models(base_url)
        if not models:
            raise RuntimeError("no models returned")
        return f"{len(models)} model records"

    models_result = _scenario("models", models_action)
    results.append(models_result)
    if not models_result.passed:
        return SmokeReport(base_url, results)

    results.append(
        _scenario(
            "chat",
            lambda: _message_content(
                chat(
                    base_url,
                    [{"role": "user", "content": "只回复：基础对话正常"}],
                    max_tokens=32,
                )
            ),
        )
    )

    def stream_action() -> str:
        response = chat(
            base_url,
            [{"role": "user", "content": "只回复：流式正常"}],
            stream=True,
            max_tokens=32,
        )
        chunks = response if isinstance(response, Iterator) else iter(())
        text = "".join(
            chunk["choices"][0]["delta"].get("content", "") for chunk in chunks
        )
        if not text.strip():
            raise RuntimeError("stream returned no content")
        return text.strip()

    results.append(_scenario("stream", stream_action))

    results.append(
        _scenario(
            "multi_turn",
            lambda: _message_content(
                chat(
                    base_url,
                    [
                        {"role": "user", "content": "记住代号是海棠。只回复收到。"},
                        {"role": "assistant", "content": "收到。"},
                        {"role": "user", "content": "代号是什么？只回复代号。"},
                    ],
                    max_tokens=32,
                )
            ),
        )
    )

    weather_tool = {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "查询指定城市的天气",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        },
    }

    def tool_action() -> str:
        response = chat(
            base_url,
            [{"role": "user", "content": "请调用工具查询北京天气，不要自行回答。"}],
            tools=[weather_tool],
            max_tokens=128,
        )
        message = response["choices"][0]["message"]
        calls = message.get("tool_calls")
        if not isinstance(calls, list) or not calls:
            raise RuntimeError(f"no structured tool_calls in response: {message}")
        return json.dumps(calls[0], ensure_ascii=False)

    results.append(_scenario("tool_call", tool_action))

    def concurrency_action() -> str:
        def one_request(index: int) -> str:
            response = chat(
                base_url,
                [{"role": "user", "content": f"只回复数字 {index}"}],
                max_tokens=16,
                timeout=300,
            )
            return _message_content(response)

        outputs: list[str] = []
        with ThreadPoolExecutor(max_workers=concurrency) as executor:
            futures = [executor.submit(one_request, index) for index in range(concurrency)]
            for future in as_completed(futures, timeout=300):
                outputs.append(future.result())
        if len(outputs) != concurrency:
            raise RuntimeError(f"completed {len(outputs)} of {concurrency} requests")
        return f"completed {len(outputs)} requests"

    results.append(_scenario(f"concurrency_{concurrency}", concurrency_action))
    return SmokeReport(base_url, results)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Smoke-test a ModelHarbor backend")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000/v1")
    parser.add_argument("--concurrency", type=int, default=5)
    args = parser.parse_args(argv)
    report = run_smoke(args.base_url, args.concurrency)
    print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
    return 0 if report.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
