import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from typing import Iterator

import pytest

from llm_service.client import ChatHTTPError, chat, list_models


class StubHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    bodies: list[dict[str, object]] = []

    def log_message(self, format: str, *args: object) -> None:
        return

    def do_GET(self) -> None:
        payload = json.dumps({"data": [{"id": "default_model"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self) -> None:
        size = int(self.headers["Content-Length"])
        body = json.loads(self.rfile.read(size))
        self.__class__.bodies.append(body)
        if body.get("messages", [{}])[-1].get("content") == "fail":
            payload = json.dumps({"error": "synthetic failure"}).encode()
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if body.get("stream"):
            chunks = [
                {"choices": [{"delta": {"content": "hel"}}]},
                {"choices": [{"delta": {"content": "lo"}}]},
            ]
            payload = b"".join(
                f"data: {json.dumps(chunk)}\n\n".encode() for chunk in chunks
            ) + b"data: [DONE]\n\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        payload = json.dumps(
            {"choices": [{"message": {"role": "assistant", "content": "你好"}}]}
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


@pytest.fixture
def stub_server() -> Iterator[str]:
    StubHandler.bodies = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), StubHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_non_streaming_chat_decodes_message(stub_server: str) -> None:
    response = chat(stub_server, [{"role": "user", "content": "你好"}])

    assert response["choices"][0]["message"]["content"] == "你好"
    assert StubHandler.bodies[-1]["model"] == "default_model"
    assert StubHandler.bodies[-1]["chat_template_kwargs"] == {
        "enable_thinking": False
    }


def test_list_models_returns_model_records(stub_server: str) -> None:
    assert list_models(stub_server) == [{"id": "default_model"}]


def test_streaming_chat_stops_at_done(stub_server: str) -> None:
    chunks = list(
        chat(
            stub_server,
            [{"role": "user", "content": "hi"}],
            stream=True,
        )
    )

    assert "".join(
        chunk["choices"][0]["delta"].get("content", "") for chunk in chunks
    ) == "hello"


def test_tools_are_forwarded_without_mutation(stub_server: str) -> None:
    tools = [
        {
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get weather",
                "parameters": {
                    "type": "object",
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"],
                },
            },
        }
    ]

    chat(stub_server, [{"role": "user", "content": "北京天气"}], tools=tools)

    assert StubHandler.bodies[-1]["tools"] == tools


def test_extra_body_enables_stream_usage(stub_server: str) -> None:
    list(
        chat(
            stub_server,
            [{"role": "user", "content": "usage"}],
            stream=True,
            extra_body={"stream_options": {"include_usage": True}},
        )
    )

    assert StubHandler.bodies[-1]["stream_options"] == {"include_usage": True}


def test_extra_body_cannot_switch_away_from_local_model(stub_server: str) -> None:
    with pytest.raises(ValueError, match="model"):
        chat(
            stub_server,
            [{"role": "user", "content": "unsafe"}],
            extra_body={"model": "remote/repository"},
        )


def test_http_errors_preserve_status_and_body(stub_server: str) -> None:
    with pytest.raises(ChatHTTPError) as caught:
        chat(stub_server, [{"role": "user", "content": "fail"}])

    assert caught.value.status == 503
    assert "synthetic failure" in caught.value.body
