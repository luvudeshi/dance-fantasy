"""The optional Vultr analysis worker: off by default, and forwards to a real HTTP worker when configured."""

from __future__ import annotations

import json
import threading
import urllib.error
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from app.vultr_worker import forward_analysis, worker_url


def test_worker_is_off_unless_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ANALYSIS_WORKER_URL", raising=False)
    assert worker_url() is None
    monkeypatch.setenv("ANALYSIS_WORKER_URL", "  ")
    assert worker_url() is None
    monkeypatch.setenv("ANALYSIS_WORKER_URL", "https://worker.dancefantasy.tech/")
    assert worker_url() == "https://worker.dancefantasy.tech"


@pytest.fixture
def worker() -> Iterator[tuple[str, list[tuple[str, dict[str, object]]]]]:
    seen: list[tuple[str, dict[str, object]]] = []

    class Worker(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            seen.append((self.path, body))
            ok = body.get("url") != "bad"
            self.send_response(200 if ok else 400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"id": "a" * 64, "bpm": 120.0} if ok else {"detail": "bad audio"}).encode())

        def log_message(self, *args: object) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Worker)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", seen
    finally:
        server.shutdown()


def test_forward_posts_the_upload_and_returns_the_analysis(worker: tuple[str, list[tuple[str, dict[str, object]]]]) -> None:
    base, seen = worker
    body = {"url": "https://x.public.blob.vercel-storage.com/uploads/song.mp3", "filename": "song.mp3", "title": None}
    assert forward_analysis(base, body, refresh=False) == {"id": "a" * 64, "bpm": 120.0}
    forward_analysis(base, body, refresh=True)
    assert seen == [("/api/analyze/blob", body), ("/api/analyze/blob?refresh=true", body)]


def test_forward_raises_the_worker_status(worker: tuple[str, list[tuple[str, dict[str, object]]]]) -> None:
    base, _ = worker
    with pytest.raises(urllib.error.HTTPError) as err:
        forward_analysis(base, {"url": "bad"}, refresh=False)
    assert err.value.code == 400
    with pytest.raises(OSError):
        forward_analysis("http://127.0.0.1:9", {"url": "x"}, refresh=False, timeout=2.0)  # nothing listens
