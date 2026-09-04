"""Small OpenAI-compatible client with strict JSON and SSE handling."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen


DEFAULT_MODEL_ALIAS = "default_model"


class ChatHTTPError(RuntimeError):
    """An HTTP failure that preserves status and response payload."""

    def __init__(self, status: int, body: str) -> None:
        super().__init__(f"chat request failed with HTTP {status}: {body}")
        self.status = status
        self.body = body


def list_models(base_url: str, timeout: float = 10) -> list[dict[str, Any]]:
    """Return model records from the backend, rejecting malformed responses."""
    request = Request(f"{base_url.rstrip('/')}/models")
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read())
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise ChatHTTPError(exc.code, body) from exc
    models = payload.get("data")
    if not isinstance(models, list):
        raise RuntimeError("model endpoint returned an invalid response")
    return models


def _request(payload: dict[str, Any], base_url: str) -> Request:
    return Request(
        f"{base_url.rstrip('/')}/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )


def _stream_response(request: Request, timeout: float) -> Iterator[dict[str, Any]]:
    try:
        with urlopen(request, timeout=timeout) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8").strip()
                if not line or not line.startswith("data:"):
                    continue
                data = line.removeprefix("data:").strip()
                if data == "[DONE]":
                    return
                yield json.loads(data)
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise ChatHTTPError(exc.code, body) from exc


def chat(
    base_url: str,
    messages: list[dict[str, Any]],
    *,
    stream: bool = False,
    tools: list[dict[str, Any]] | None = None,
    max_tokens: int = 64,
    enable_thinking: bool = False,
    timeout: float = 300,
    extra_body: dict[str, Any] | None = None,
) -> dict[str, Any] | Iterator[dict[str, Any]]:
    """Send a chat request while pinning MLX-LM to its loaded local model."""
    payload: dict[str, Any] = {
        "model": DEFAULT_MODEL_ALIAS,
        "messages": messages,
        "stream": stream,
        "max_tokens": max_tokens,
        "chat_template_kwargs": {"enable_thinking": enable_thinking},
    }
    if tools:
        payload["tools"] = tools
    if extra_body:
        protected = {"model", "messages"}.intersection(extra_body)
        if protected:
            names = ", ".join(sorted(protected))
            raise ValueError(f"extra_body cannot override protected fields: {names}")
        payload.update(extra_body)
    request = _request(payload, base_url)
    if stream:
        return _stream_response(request, timeout)
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise ChatHTTPError(exc.code, body) from exc
