import hashlib
from pathlib import Path
from typing import Any, BinaryIO, cast

import pytest
from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from voiceverse_ai.core.config import Settings
from voiceverse_ai.media.errors import MediaExecutionError
from voiceverse_ai.media.storage import S3ObjectStore


class FakeBody:
    def __init__(self, content: bytes) -> None:
        self._content = content
        self._position = 0
        self.closed = False

    def read(self, amount: int | None = None) -> bytes:
        amount = amount or len(self._content)
        result = self._content[self._position : self._position + amount]
        self._position += len(result)
        return result

    def close(self) -> None:
        self.closed = True


def _client_error(code: str, status: int, operation: str) -> ClientError:
    return ClientError(
        {"Error": {"Code": code}, "ResponseMetadata": {"HTTPStatusCode": status}},
        operation,
    )


class FakeS3:
    def __init__(self, content: bytes = b"source") -> None:
        self.content = content
        self.body = FakeBody(content)
        self.get_error: ClientError | None = None
        self.head_bucket_error: ClientError | None = None
        self.put_error: ClientError | None = None
        self.head: dict[str, Any] = {}
        self.uploaded = b""
        self.put_kwargs: dict[str, object] = {}

    def get_object(self, **_kwargs: object) -> dict[str, Any]:
        if self.get_error:
            raise self.get_error
        return {"ContentLength": len(self.content), "Body": self.body}

    def head_bucket(self, **_kwargs: object) -> dict[str, Any]:
        if self.head_bucket_error:
            raise self.head_bucket_error
        return {}

    def put_object(self, **kwargs: object) -> dict[str, Any]:
        self.put_kwargs = kwargs
        body = kwargs["Body"]
        assert hasattr(body, "read")
        self.uploaded = cast("BinaryIO", body).read()
        if self.put_error:
            raise self.put_error
        return {}

    def head_object(self, **_kwargs: object) -> dict[str, Any]:
        return self.head


def _store(client: FakeS3) -> S3ObjectStore:
    return S3ObjectStore(Settings(environment="test"), client=client)


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_readiness_uses_the_executor_bucket_credentials() -> None:
    client = FakeS3()
    store = _store(client)

    assert await store.is_ready(bucket="voiceverse-test")

    client.head_bucket_error = _client_error("AccessDenied", 403, "HeadBucket")
    assert not await store.is_ready(bucket="voiceverse-test")


@pytest.mark.anyio
async def test_download_streams_to_private_file_and_verifies_integrity(tmp_path: Path) -> None:
    content = b"trusted source bytes"
    client = FakeS3(content)
    destination = tmp_path / "source"

    await _store(client).download_verified(
        bucket="voiceverse-test",
        key="source-key",
        destination=destination,
        expected_size=len(content),
        expected_sha256=hashlib.sha256(content).hexdigest(),
        max_size=1024,
    )

    assert destination.read_bytes() == content
    assert destination.stat().st_mode & 0o777 == 0o600
    assert client.body.closed


@pytest.mark.anyio
async def test_download_rejects_missing_or_mismatched_source(tmp_path: Path) -> None:
    missing = FakeS3()
    missing.get_error = _client_error("NoSuchKey", 404, "GetObject")
    with pytest.raises(MediaExecutionError, match="MEDIA_SOURCE_NOT_FOUND"):
        await _store(missing).download_verified(
            bucket="voiceverse-test",
            key="missing",
            destination=tmp_path / "missing",
            expected_size=6,
            expected_sha256="0" * 64,
            max_size=1024,
        )

    mismatch = FakeS3()
    with pytest.raises(MediaExecutionError, match="MEDIA_SOURCE_CHECKSUM_MISMATCH"):
        await _store(mismatch).download_verified(
            bucket="voiceverse-test",
            key="source",
            destination=tmp_path / "mismatch",
            expected_size=6,
            expected_sha256="0" * 64,
            max_size=1024,
        )
    assert not (tmp_path / "mismatch").exists()


@pytest.mark.anyio
async def test_download_enforces_recorded_and_maximum_sizes(tmp_path: Path) -> None:
    with pytest.raises(MediaExecutionError) as too_large:
        await _store(FakeS3()).download_verified(
            bucket="voiceverse-test",
            key="source",
            destination=tmp_path / "large",
            expected_size=2048,
            expected_sha256="0" * 64,
            max_size=1024,
        )
    assert too_large.value.code == "MEDIA_SOURCE_TOO_LARGE"

    with pytest.raises(MediaExecutionError) as mismatch:
        await _store(FakeS3()).download_verified(
            bucket="voiceverse-test",
            key="source",
            destination=tmp_path / "wrong-size",
            expected_size=5,
            expected_sha256="0" * 64,
            max_size=1024,
        )
    assert mismatch.value.code == "MEDIA_SOURCE_SIZE_MISMATCH"


@pytest.mark.anyio
async def test_upload_sets_integrity_metadata_and_server_side_encryption(tmp_path: Path) -> None:
    source = tmp_path / "artifact"
    source.write_bytes(b"artifact")
    digest = hashlib.sha256(b"artifact").hexdigest()
    client = FakeS3()
    store = S3ObjectStore(Settings(environment="test", s3_sse_algorithm="AES256"), client=client)

    await store.upload_immutable(
        bucket="voiceverse-test",
        key="artifact-key",
        source=source,
        media_type="audio/flac",
        sha256=digest,
        metadata={"artifact-kind": "canonical_audio"},
    )

    assert client.uploaded == b"artifact"
    assert client.put_kwargs["IfNoneMatch"] == "*"
    assert client.put_kwargs["ServerSideEncryption"] == "AES256"
    assert client.put_kwargs["Metadata"] == {
        "artifact-kind": "canonical_audio",
        "sha256": digest,
    }


@pytest.mark.anyio
async def test_storage_provider_failures_have_stable_gateway_errors(tmp_path: Path) -> None:
    denied = FakeS3()
    denied.get_error = _client_error("AccessDenied", 403, "GetObject")
    with pytest.raises(MediaExecutionError) as download_error:
        await _store(denied).download_verified(
            bucket="voiceverse-test",
            key="source",
            destination=tmp_path / "source",
            expected_size=6,
            expected_sha256="0" * 64,
            max_size=1024,
        )
    assert download_error.value.code == "STORAGE_DOWNLOAD_FAILED"

    source = tmp_path / "artifact"
    source.write_bytes(b"artifact")
    failed_upload = FakeS3()
    failed_upload.put_error = _client_error("InternalError", 500, "PutObject")
    with pytest.raises(MediaExecutionError) as upload_error:
        await _store(failed_upload).upload_immutable(
            bucket="voiceverse-test",
            key="artifact",
            source=source,
            media_type="audio/flac",
            sha256=hashlib.sha256(b"artifact").hexdigest(),
            metadata={},
        )
    assert upload_error.value.code == "STORAGE_UPLOAD_FAILED"


@pytest.mark.anyio
async def test_immutable_upload_is_idempotent_only_for_matching_content(tmp_path: Path) -> None:
    content = b"artifact"
    source = tmp_path / "artifact"
    source.write_bytes(content)
    digest = hashlib.sha256(content).hexdigest()
    client = FakeS3()
    client.put_error = _client_error("PreconditionFailed", 412, "PutObject")
    client.head = {
        "ContentLength": len(content),
        "ContentType": "audio/flac",
        "Metadata": {"artifact-kind": "canonical_audio", "sha256": digest},
    }

    await _store(client).upload_immutable(
        bucket="voiceverse-test",
        key="artifact-key",
        source=source,
        media_type="audio/flac",
        sha256=digest,
        metadata={"artifact-kind": "canonical_audio"},
    )

    client.head = {"ContentLength": len(content), "Metadata": {"sha256": "0" * 64}}
    with pytest.raises(MediaExecutionError, match="ARTIFACT_ALREADY_EXISTS"):
        await _store(client).upload_immutable(
            bucket="voiceverse-test",
            key="artifact-key",
            source=source,
            media_type="audio/flac",
            sha256=digest,
            metadata={},
        )

    client.head = {
        "ContentLength": len(content),
        "ContentType": "application/json",
        "Metadata": {"artifact-kind": "canonical_audio", "sha256": digest},
    }
    with pytest.raises(MediaExecutionError, match="ARTIFACT_ALREADY_EXISTS"):
        await _store(client).upload_immutable(
            bucket="voiceverse-test",
            key="artifact-key",
            source=source,
            media_type="audio/flac",
            sha256=digest,
            metadata={"artifact-kind": "canonical_audio"},
        )
