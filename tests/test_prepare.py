import json
from pathlib import Path

import pytest

import llm_service.prepare as prepare
from llm_service.prepare import check_host, download_model


def test_disk_check_requires_twelve_gib(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="12 GiB"):
        check_host(tmp_path, free_bytes=11 * 1024**3)


def test_wrong_platform_is_rejected(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(prepare.platform, "system", lambda: "Linux")

    with pytest.raises(RuntimeError, match="Apple Silicon"):
        check_host(tmp_path, free_bytes=20 * 1024**3)


def test_manifest_records_revision_and_size(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    revision = "0123456789abcdef0123456789abcdef01234567"
    model_dir = tmp_path / "models" / "Qwen3.5-9B-4bit"

    def fake_snapshot_download(**kwargs: object) -> str:
        destination = Path(str(kwargs["local_dir"]))
        destination.mkdir(parents=True)
        (destination / "config.json").write_text("{}", encoding="utf-8")
        (destination / "model.safetensors").write_bytes(b"1234")
        return str(destination)

    class FakeInfo:
        sha = revision

    class FakeApi:
        def model_info(self, model_id: str, revision: str) -> FakeInfo:
            assert model_id == "mlx-community/Qwen3.5-9B-4bit"
            assert revision == "main"
            return FakeInfo()

    monkeypatch.setattr(prepare, "snapshot_download", fake_snapshot_download)
    monkeypatch.setattr(prepare, "HfApi", FakeApi)

    result = download_model("mlx-community/Qwen3.5-9B-4bit", model_dir)

    assert result["model_id"] == "mlx-community/Qwen3.5-9B-4bit"
    assert result["revision"] == revision
    assert result["bytes"] == 6
    manifest = json.loads(
        (tmp_path / "runtime/model-revision.json").read_text(encoding="utf-8")
    )
    assert manifest == result


def test_download_rejects_incomplete_snapshot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    model_dir = tmp_path / "models" / "Qwen3.5-9B-4bit"

    def fake_snapshot_download(**kwargs: object) -> str:
        destination = Path(str(kwargs["local_dir"]))
        destination.mkdir(parents=True)
        (destination / "config.json").write_text("{}", encoding="utf-8")
        return str(destination)

    class FakeApi:
        def model_info(self, model_id: str, revision: str) -> object:
            return type("Info", (), {"sha": "a" * 40})()

    monkeypatch.setattr(prepare, "snapshot_download", fake_snapshot_download)
    monkeypatch.setattr(prepare, "HfApi", FakeApi)

    with pytest.raises(RuntimeError, match="safetensor"):
        download_model("mlx-community/Qwen3.5-9B-4bit", model_dir)


def test_prepare_script_preserves_existing_environment() -> None:
    script = Path("scripts/prepare.sh").read_text(encoding="utf-8")

    assert "--clear" not in script
    assert 'if [[ ! -x "$ROOT_DIR/.venv/bin/python" ]]' in script
