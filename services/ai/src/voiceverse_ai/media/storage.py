import asyncio
import hashlib
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Never, Protocol, cast

import boto3  # type: ignore[import-untyped]
from botocore.config import Config  # type: ignore[import-untyped]
from botocore.exceptions import BotoCoreError, ClientError  # type: ignore[import-untyped]

from voiceverse_ai.core.config import Settings
from voiceverse_ai.media.errors import MediaExecutionError, media_error

_CHUNK_SIZE = 1024 * 1024


class StreamingBody(Protocol):
    def read(self, amount: int | None = None) -> bytes: ...

    def close(self) -> None: ...


class S3Client(Protocol):
    def get_object(self, **kwargs: object) -> dict[str, Any]: ...

    def head_bucket(self, **kwargs: object) -> dict[str, Any]: ...

    def put_object(self, **kwargs: object) -> dict[str, Any]: ...

    def head_object(self, **kwargs: object) -> dict[str, Any]: ...


class ObjectStore(Protocol):
    async def is_ready(self, *, bucket: str) -> bool: ...

    async def download_verified(
        self,
        *,
        bucket: str,
        key: str,
        destination: Path,
        expected_size: int,
        expected_sha256: str,
        max_size: int,
    ) -> None: ...

    async def upload_immutable(
        self,
        *,
        bucket: str,
        key: str,
        source: Path,
        media_type: str,
        sha256: str,
        metadata: Mapping[str, str],
    ) -> None: ...


class S3ObjectStore:
    """Blocking boto3 operations isolated behind async thread boundaries."""

    def __init__(self, settings: Settings, client: S3Client | None = None) -> None:
        self._settings = settings
        self._client_override = client
        self._client_instance: S3Client | None = None

    async def is_ready(self, *, bucket: str) -> bool:
        """Verify that this executor's own S3 client can reach its configured bucket."""
        return await asyncio.to_thread(self._is_ready_sync, bucket)

    def _is_ready_sync(self, bucket: str) -> bool:
        try:
            self._client.head_bucket(Bucket=bucket)
        except (BotoCoreError, ClientError):
            return False
        return True

    @property
    def _client(self) -> S3Client:
        if self._client_override is not None:
            return self._client_override
        if self._client_instance is None:
            credentials: dict[str, str] = {}
            access_key = self._settings.s3_access_key
            secret_key = self._settings.s3_secret_key
            if access_key is not None and secret_key is not None:
                credentials["aws_access_key_id"] = access_key.get_secret_value()
                credentials["aws_secret_access_key"] = secret_key.get_secret_value()
            endpoint = str(self._settings.s3_endpoint) if self._settings.s3_endpoint else None
            self._client_instance = cast(
                "S3Client",
                boto3.client(
                    "s3",
                    endpoint_url=endpoint,
                    region_name=self._settings.s3_region,
                    config=Config(
                        connect_timeout=10,
                        read_timeout=60,
                        retries={"max_attempts": 3, "mode": "standard"},
                        s3={
                            "addressing_style": (
                                "path" if self._settings.s3_force_path_style else "virtual"
                            )
                        },
                    ),
                    **credentials,
                ),
            )
        return self._client_instance

    async def download_verified(
        self,
        *,
        bucket: str,
        key: str,
        destination: Path,
        expected_size: int,
        expected_sha256: str,
        max_size: int,
    ) -> None:
        await asyncio.to_thread(
            self._download_verified_sync,
            bucket,
            key,
            destination,
            expected_size,
            expected_sha256,
            max_size,
        )

    def _download_verified_sync(
        self,
        bucket: str,
        key: str,
        destination: Path,
        expected_size: int,
        expected_sha256: str,
        max_size: int,
    ) -> None:
        if expected_size > max_size:
            raise media_error("MEDIA_SOURCE_TOO_LARGE", "Source media exceeds the size limit.", 413)

        try:
            response = self._client.get_object(Bucket=bucket, Key=key)
        except ClientError as error:
            self._raise_download_error(error)
        except BotoCoreError as error:
            raise media_error(
                "STORAGE_DOWNLOAD_FAILED", "Source media could not be downloaded.", 502
            ) from error

        content_length = int(response.get("ContentLength", -1))
        if content_length > max_size:
            raise media_error("MEDIA_SOURCE_TOO_LARGE", "Source media exceeds the size limit.", 413)
        if content_length >= 0 and content_length != expected_size:
            raise media_error(
                "MEDIA_SOURCE_SIZE_MISMATCH", "Source media size does not match its record.", 409
            )

        body = cast("StreamingBody", response["Body"])
        digest = hashlib.sha256()
        downloaded = 0
        file_descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(file_descriptor, "wb") as output:
                while chunk := body.read(_CHUNK_SIZE):
                    downloaded += len(chunk)
                    if downloaded > max_size:
                        raise media_error(
                            "MEDIA_SOURCE_TOO_LARGE", "Source media exceeds the size limit.", 413
                        )
                    digest.update(chunk)
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
        except MediaExecutionError:
            destination.unlink(missing_ok=True)
            raise
        except BotoCoreError as error:
            destination.unlink(missing_ok=True)
            raise media_error(
                "STORAGE_DOWNLOAD_FAILED", "Source media could not be downloaded.", 502
            ) from error
        except OSError as error:
            destination.unlink(missing_ok=True)
            raise media_error(
                "MEDIA_SCRATCH_UNAVAILABLE", "Secure media scratch space is unavailable.", 507
            ) from error
        finally:
            body.close()

        if downloaded != expected_size:
            destination.unlink(missing_ok=True)
            raise media_error(
                "MEDIA_SOURCE_SIZE_MISMATCH", "Source media size does not match its record.", 409
            )
        if digest.hexdigest() != expected_sha256:
            destination.unlink(missing_ok=True)
            raise media_error(
                "MEDIA_SOURCE_CHECKSUM_MISMATCH",
                "Source media checksum does not match its record.",
                409,
            )

    @staticmethod
    def _raise_download_error(error: ClientError) -> Never:
        error_code = str(error.response.get("Error", {}).get("Code", "Unknown"))
        if error_code in {"404", "NoSuchKey", "NotFound"}:
            raise media_error(
                "MEDIA_SOURCE_NOT_FOUND", "Source media was not found.", 404
            ) from error
        raise media_error(
            "STORAGE_DOWNLOAD_FAILED", "Source media could not be downloaded.", 502
        ) from error

    async def upload_immutable(
        self,
        *,
        bucket: str,
        key: str,
        source: Path,
        media_type: str,
        sha256: str,
        metadata: Mapping[str, str],
    ) -> None:
        await asyncio.to_thread(
            self._upload_immutable_sync,
            bucket,
            key,
            source,
            media_type,
            sha256,
            metadata,
        )

    def _upload_immutable_sync(
        self,
        bucket: str,
        key: str,
        source: Path,
        media_type: str,
        sha256: str,
        metadata: Mapping[str, str],
    ) -> None:
        size = source.stat().st_size
        expected_metadata = {**metadata, "sha256": sha256}
        encryption: dict[str, str] = {}
        if self._settings.s3_sse_algorithm != "none":
            encryption["ServerSideEncryption"] = self._settings.s3_sse_algorithm
        if self._settings.s3_kms_key_id:
            encryption["SSEKMSKeyId"] = self._settings.s3_kms_key_id

        try:
            with source.open("rb") as body:
                self._client.put_object(
                    Bucket=bucket,
                    Key=key,
                    Body=body,
                    ContentLength=size,
                    ContentType=media_type,
                    IfNoneMatch="*",
                    Metadata=expected_metadata,
                    **encryption,
                )
        except ClientError as error:
            error_code = str(error.response.get("Error", {}).get("Code", "Unknown"))
            status = int(error.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0))
            if error_code in {
                "PreconditionFailed",
                "412",
                "ConditionalRequestConflict",
            } or status in {
                409,
                412,
            }:
                self._accept_matching_existing_object(
                    bucket,
                    key,
                    size,
                    media_type,
                    expected_metadata,
                    encryption,
                    error,
                )
                return
            raise media_error(
                "STORAGE_UPLOAD_FAILED", "A media artifact could not be stored.", 502
            ) from error
        except BotoCoreError as error:
            raise media_error(
                "STORAGE_UPLOAD_FAILED", "A media artifact could not be stored.", 502
            ) from error

    def _accept_matching_existing_object(
        self,
        bucket: str,
        key: str,
        expected_size: int,
        expected_media_type: str,
        expected_metadata: Mapping[str, str],
        expected_encryption: Mapping[str, str],
        original_error: ClientError,
    ) -> None:
        try:
            existing = self._client.head_object(Bucket=bucket, Key=key)
        except (BotoCoreError, ClientError) as head_error:
            raise media_error(
                "STORAGE_UPLOAD_FAILED", "A media artifact could not be stored.", 502
            ) from head_error

        metadata = cast("Mapping[str, str]", existing.get("Metadata", {}))
        encryption_matches = not expected_encryption or (
            existing.get("ServerSideEncryption") == expected_encryption.get("ServerSideEncryption")
            and (
                "SSEKMSKeyId" not in expected_encryption
                or existing.get("SSEKMSKeyId") == expected_encryption.get("SSEKMSKeyId")
            )
        )
        if (
            int(existing.get("ContentLength", -1)) != expected_size
            or existing.get("ContentType") != expected_media_type
            or dict(metadata) != dict(expected_metadata)
            or not encryption_matches
        ):
            raise media_error(
                "ARTIFACT_ALREADY_EXISTS",
                "An immutable artifact already exists with different content.",
                409,
            ) from original_error
