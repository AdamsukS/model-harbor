"""Reproducible KV/prompt-cache experiments for a running backend."""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass, field
from importlib.metadata import version
import json
import os
from pathlib import Path
import signal
from threading import Event, Thread
import time
from collections.abc import Callable, Iterator
from typing import Any

import psutil
from transformers import AutoTokenizer

from llm_service.client import chat
from llm_service.config import ServiceConfig


PROFILE_TOKENS = {"32k": 32_768, "64k": 65_536, "128k": 131_072}
DEFAULT_SEED = (
    "cache experiment deterministic prefix agent context tools observation plan "
    "memory retrieval inference scheduling reproducible measurement apple metal "
)
DIFFERENT_SEED = (
    "independent control sequence benchmark alternate history function response "
    "latency throughput state machine attention cache qwen local service stable "
)


@dataclass(frozen=True, slots=True)
class Measurement:
    scenario: str
    target_tokens: int
    prompt_tokens: int
    cached_tokens: int
    completion_tokens: int
    ttft_seconds: float
    total_seconds: float
    tokens_per_second: float
    rss_before: int
    rss_peak: int
    rss_after: int
    success: bool
    error: str = ""


@dataclass(slots=True)
class SwapWatchdog:
    """Stop a benchmark backend when swap growth crosses a hard limit."""

    baseline: int
    limit: int
    read_swap: Callable[[], int]
    on_exceed: Callable[[], None]
    interval: float = 0.5
    exceeded: bool = False
    _stop: Event = field(default_factory=Event, init=False, repr=False)
    _thread: Thread | None = field(default=None, init=False, repr=False)

    def poll_once(self) -> bool:
        if self.exceeded:
            return True
        if self.read_swap() - self.baseline >= self.limit:
            self.exceeded = True
            self.on_exceed()
        return self.exceeded

    def _run(self) -> None:
        while not self._stop.wait(self.interval):
            if self.poll_once():
                return

    def start(self) -> None:
        self._thread = Thread(target=self._run, daemon=True, name="swap-watchdog")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=max(self.interval * 2, 1))


def calibrate_prompt(
    target_tokens: int,
    measure: Callable[[str], int],
    seed: str = DEFAULT_SEED,
) -> str:
    """Find a deterministic prompt within two percent of a token target."""
    if target_tokens <= 0:
        raise ValueError("target_tokens must be positive")
    words = seed.split()

    def build(repetitions: int) -> str:
        return " ".join(words * repetitions)

    low, high = 1, max(2, target_tokens // max(len(words), 1) * 2)
    while measure(build(high)) < target_tokens:
        high *= 2

    best = build(high)
    while low <= high:
        middle = (low + high) // 2
        candidate = build(middle)
        count = measure(candidate)
        if abs(count - target_tokens) < abs(measure(best) - target_tokens):
            best = candidate
        if count < target_tokens:
            low = middle + 1
        elif count > target_tokens:
            high = middle - 1
        else:
            return candidate
    return best


def _process_rss(pid: int) -> int:
    process = psutil.Process(pid)
    total = process.memory_info().rss
    for child in process.children(recursive=True):
        try:
            total += child.memory_info().rss
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return total


def _safe_memory(
    memory_fn: Callable[[int], int], pid: int, fallback: int
) -> int:
    try:
        return memory_fn(pid)
    except Exception:
        return fallback


def _measure_request(
    scenario: str,
    base_url: str,
    messages: list[dict[str, Any]],
    target_tokens: int,
    service_pid: int,
    chat_fn: Callable[..., dict[str, Any] | Iterator[dict[str, Any]]],
    memory_fn: Callable[[int], int],
    watchdog: SwapWatchdog | None = None,
) -> Measurement:
    rss_before = memory_fn(service_pid)
    rss_peak = rss_before
    started = time.perf_counter()
    first_token_at: float | None = None
    usage: dict[str, Any] | None = None
    if watchdog is not None:
        watchdog.start()
    try:
        response = chat_fn(
            base_url,
            messages,
            stream=True,
            max_tokens=8,
            enable_thinking=False,
            timeout=1200,
            extra_body={"stream_options": {"include_usage": True}},
        )
        if isinstance(response, dict):
            raise RuntimeError("benchmark requires an SSE response")
        for chunk in response:
            now = time.perf_counter()
            rss_peak = max(rss_peak, memory_fn(service_pid))
            choices = chunk.get("choices", [])
            if choices and first_token_at is None:
                delta = choices[0].get("delta", {})
                if any(delta.get(key) for key in ("content", "reasoning", "tool_calls")):
                    first_token_at = now
            if isinstance(chunk.get("usage"), dict):
                usage = chunk["usage"]
        finished = time.perf_counter()
        if watchdog is not None:
            watchdog.stop()
            if watchdog.exceeded:
                raise RuntimeError("swap growth reached the 1 GiB safety limit")
        rss_after = memory_fn(service_pid)
        rss_peak = max(rss_peak, rss_after)
        if usage is None:
            raise RuntimeError("stream ended without usage metrics")
        if first_token_at is None:
            raise RuntimeError("stream ended without a generated token")
        prompt_tokens = int(usage["prompt_tokens"])
        completion_tokens = int(usage["completion_tokens"])
        cached_tokens = int(
            usage.get("prompt_tokens_details", {}).get("cached_tokens", 0)
        )
        decode_seconds = max(finished - first_token_at, 1e-9)
        return Measurement(
            scenario=scenario,
            target_tokens=target_tokens,
            prompt_tokens=prompt_tokens,
            cached_tokens=cached_tokens,
            completion_tokens=completion_tokens,
            ttft_seconds=first_token_at - started,
            total_seconds=finished - started,
            tokens_per_second=completion_tokens / decode_seconds,
            rss_before=rss_before,
            rss_peak=rss_peak,
            rss_after=rss_after,
            success=True,
        )
    except Exception as exc:
        if watchdog is not None:
            watchdog.stop()
            if watchdog.exceeded:
                exc = RuntimeError("swap growth reached the 1 GiB safety limit")
        finished = time.perf_counter()
        rss_after = _safe_memory(memory_fn, service_pid, rss_peak)
        return Measurement(
            scenario=scenario,
            target_tokens=target_tokens,
            prompt_tokens=0,
            cached_tokens=0,
            completion_tokens=0,
            ttft_seconds=0,
            total_seconds=finished - started,
            tokens_per_second=0,
            rss_before=rss_before,
            rss_peak=max(rss_peak, rss_after),
            rss_after=rss_after,
            success=False,
            error=f"{type(exc).__name__}: {exc}",
        )


def run_cache_scenario(
    base_url: str,
    target_tokens: int,
    service_pid: int,
    measure: Callable[[str], int],
    chat_fn: Callable[..., dict[str, Any] | Iterator[dict[str, Any]]] = chat,
    memory_fn: Callable[[int], int] = _process_rss,
    swap_baseline: int | None = None,
    max_swap_delta: int | None = None,
    swap_fn: Callable[[], int] = lambda: psutil.swap_memory().used,
    terminate_fn: Callable[[int], None] = lambda pid: os.kill(pid, signal.SIGTERM),
) -> list[Measurement]:
    """Compare a cold prefix, its hot reuse, and an unrelated prefix."""
    prefix_target = max(1, target_tokens - 64)
    shared_prefix = calibrate_prompt(prefix_target, measure, DEFAULT_SEED)
    different_prefix = calibrate_prompt(prefix_target, measure, DIFFERENT_SEED)
    scenarios = [
        (
            "cold",
            [
                {"role": "system", "content": shared_prefix},
                {"role": "user", "content": "Return only COLD."},
            ],
        ),
        (
            "shared_prefix_hot",
            [
                {"role": "system", "content": shared_prefix},
                {"role": "user", "content": "Return only HOT."},
            ],
        ),
        (
            "different_prefix",
            [
                {"role": "system", "content": different_prefix},
                {"role": "user", "content": "Return only CONTROL."},
            ],
        ),
    ]
    records: list[Measurement] = []
    for name, messages in scenarios:
        watchdog = None
        if swap_baseline is not None and max_swap_delta is not None:
            watchdog = SwapWatchdog(
                baseline=swap_baseline,
                limit=max_swap_delta,
                read_swap=swap_fn,
                on_exceed=lambda: terminate_fn(service_pid),
            )
        record = _measure_request(
            name,
            base_url,
            messages,
            target_tokens,
            service_pid,
            chat_fn,
            memory_fn,
            watchdog,
        )
        records.append(record)
        if not record.success:
            break
    return records


def _append_report(
    path: Path,
    profile: str,
    measurements: list[Measurement],
    cache_size: int,
    cache_bytes: str,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text(
            "# KV / Prompt Cache Baseline\n\n"
            "| Profile | Cache entries | Cache cap | Scenario | Prompt tokens | Cached tokens | TTFT (s) | Total (s) | Peak RSS (GiB) | Result |\n"
            "|---|---:|---:|---|---:|---:|---:|---:|---:|---|\n",
            encoding="utf-8",
        )
    with path.open("a", encoding="utf-8") as report:
        for item in measurements:
            result = "pass" if item.success else f"fail: {item.error}"
            report.write(
                f"| {profile} | {cache_size} | {cache_bytes} | {item.scenario} | {item.prompt_tokens} | "
                f"{item.cached_tokens} | {item.ttft_seconds:.3f} | "
                f"{item.total_seconds:.3f} | {item.rss_peak / 1024**3:.3f} | {result} |\n"
            )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Benchmark local prompt-cache reuse")
    parser.add_argument("profile", choices=PROFILE_TOKENS)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000/v1")
    args = parser.parse_args(argv)

    root = Path(__file__).resolve().parents[1]
    config = ServiceConfig.load(root)
    profile_index = list(PROFILE_TOKENS).index(args.profile)
    if profile_index:
        prerequisite = list(PROFILE_TOKENS)[profile_index - 1]
        prerequisite_path = config.runtime_dir / "results" / f"{prerequisite}.json"
        if not prerequisite_path.exists():
            raise RuntimeError(f"run successful {prerequisite} profile first")
        prerequisite_data = json.loads(prerequisite_path.read_text(encoding="utf-8"))
        if not prerequisite_data.get("success"):
            raise RuntimeError(f"{prerequisite} profile did not succeed")

    pid_record = json.loads((config.runtime_dir / "mlx.pid").read_text(encoding="utf-8"))
    service_pid = int(pid_record["pid"])
    tokenizer = AutoTokenizer.from_pretrained(
        config.model_dir,
        local_files_only=True,
        trust_remote_code=False,
    )
    measure = lambda text: len(tokenizer.encode(text, add_special_tokens=False))
    swap_before = psutil.swap_memory().used
    records = run_cache_scenario(
        args.base_url,
        PROFILE_TOKENS[args.profile],
        service_pid,
        measure,
        swap_baseline=swap_before,
        max_swap_delta=1024**3,
    )
    swap_after = psutil.swap_memory().used
    success = all(record.success for record in records) and swap_after - swap_before < 1024**3
    payload = {
        "profile": args.profile,
        "target_tokens": PROFILE_TOKENS[args.profile],
        "backend": "mlx-lm",
        "backend_version": version("mlx-lm"),
        "mlx_version": version("mlx"),
        "model_revision": json.loads(
            (config.runtime_dir / "model-revision.json").read_text(encoding="utf-8")
        )["revision"],
        "prompt_cache_bytes": config.prompt_cache_bytes,
        "prompt_cache_size": config.prompt_cache_size,
        "prompt_concurrency": config.prompt_concurrency,
        "decode_concurrency": config.decode_concurrency,
        "swap_before": swap_before,
        "swap_after": swap_after,
        "success": success,
        "measurements": [asdict(record) for record in records],
    }
    result_dir = config.runtime_dir / "results"
    result_dir.mkdir(parents=True, exist_ok=True)
    result_path = result_dir / f"{args.profile}.json"
    result_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    _append_report(
        root / "results/cache-baseline.md",
        args.profile,
        records,
        config.prompt_cache_size,
        config.prompt_cache_bytes,
    )
    print(json.dumps(payload, indent=2))
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())
