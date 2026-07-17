import asyncio
import json
import os
import re
import signal
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from voiceverse_ai.core.config import Settings
from voiceverse_ai.media.errors import media_error

_VERSION_PATTERN = re.compile(r"^ff(?:mpeg|probe) version ([^\s]+)")


@dataclass(frozen=True, slots=True)
class CommandResult:
    stdout: bytes
    stderr: bytes
    stdout_truncated: bool
    stderr_truncated: bool


@dataclass(frozen=True, slots=True)
class _CapturedStream:
    content: bytes
    truncated: bool


class MediaToolchain:
    """Runs local media tools without a shell or network-capable protocols."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def is_ready(self) -> bool:
        return all(self._is_executable(binary) for binary in self._binary_names())

    @staticmethod
    def _is_executable(binary: str) -> bool:
        if os.path.isabs(binary):
            return Path(binary).is_file() and os.access(binary, os.X_OK)
        paths = os.environ.get("PATH", "").split(os.pathsep)
        return any(
            (candidate := Path(path) / binary).is_file() and os.access(candidate, os.X_OK)
            for path in paths
        )

    def _binary_names(self) -> tuple[str, str]:
        return self._settings.ffmpeg_binary, self._settings.ffprobe_binary

    async def versions(self) -> tuple[str, str]:
        ffmpeg, ffprobe = await asyncio.gather(
            self._version(self._settings.ffmpeg_binary),
            self._version(self._settings.ffprobe_binary),
        )
        return ffmpeg, ffprobe

    async def _version(self, binary: str) -> str:
        result = await self._run_command(
            [binary, "-version"],
            timeout_seconds=min(self._settings.media_probe_timeout_seconds, 30),
            failure_code="MEDIA_TOOL_UNAVAILABLE",
            failure_message="The required media toolchain is unavailable.",
            timeout_code="MEDIA_TOOL_UNAVAILABLE",
            failure_status_code=503,
        )
        first_line = result.stdout.decode("utf-8", errors="replace").splitlines()[0:1]
        match = _VERSION_PATTERN.match(first_line[0]) if first_line else None
        if match is None:
            raise media_error(
                "MEDIA_TOOL_UNAVAILABLE", "The required media toolchain is unavailable.", 503
            )
        return match.group(1)[:64]

    async def probe(self, source: Path) -> dict[str, Any]:
        result = await self._run_command(
            [
                self._settings.ffprobe_binary,
                "-v",
                "error",
                "-protocol_whitelist",
                "file,pipe",
                "-show_entries",
                (
                    "format=format_name,duration,bit_rate:"
                    "stream=index,codec_type,codec_name,profile,channels,channel_layout,sample_rate,"
                    "width,height,avg_frame_rate,r_frame_rate,bit_rate,start_time,time_base,duration:"
                    "stream_disposition=default:stream_tags=language"
                ),
                "-of",
                "json",
                str(source),
            ],
            timeout_seconds=self._settings.media_probe_timeout_seconds,
            failure_code="MEDIA_PROBE_FAILED",
            failure_message="Media structure could not be validated.",
            timeout_code="MEDIA_PROBE_TIMEOUT",
        )
        if result.stdout_truncated:
            raise media_error("MEDIA_PROBE_FAILED", "Media structure could not be validated.", 422)
        try:
            document = json.loads(result.stdout)
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise media_error(
                "MEDIA_PROBE_FAILED", "Media structure could not be validated.", 422
            ) from error
        if not isinstance(document, dict):
            raise media_error("MEDIA_PROBE_FAILED", "Media structure could not be validated.", 422)
        return cast("dict[str, Any]", document)

    async def transcode_audio(
        self,
        *,
        source: Path,
        stream_index: int,
        canonical_output: Path,
        analysis_output: Path,
    ) -> None:
        mapping = f"0:{stream_index}"
        common_output_options = [
            "-vn",
            "-sn",
            "-dn",
            "-map_metadata",
            "-1",
            "-map_chapters",
            "-1",
            "-c:a",
            "flac",
            "-compression_level",
            "8",
            "-threads",
            str(self._settings.media_ffmpeg_threads),
            "-fflags",
            "+bitexact",
            "-flags:a",
            "+bitexact",
        ]
        # Film/TV delivery uses 48 kHz. The master keeps every selected source
        # channel but normalizes its clock to 48 kHz so downstream stems can be
        # mixed without implicit, provider-dependent resampling.
        await self._run_command(
            [
                self._settings.ffmpeg_binary,
                "-hide_banner",
                "-v",
                "error",
                "-nostdin",
                "-n",
                "-max_alloc",
                "536870912",
                "-protocol_whitelist",
                "file,pipe",
                "-i",
                str(source),
                "-map",
                mapping,
                *common_output_options,
                "-ar",
                "48000",
                str(canonical_output),
                "-map",
                mapping,
                *common_output_options,
                "-ac",
                "1",
                "-ar",
                "16000",
                str(analysis_output),
            ],
            timeout_seconds=self._settings.media_transcode_timeout_seconds,
            failure_code="MEDIA_TRANSCODE_FAILED",
            failure_message="Audio artifacts could not be generated.",
            timeout_code="MEDIA_TRANSCODE_TIMEOUT",
        )

    async def _run_command(
        self,
        arguments: list[str],
        *,
        timeout_seconds: int,
        failure_code: str,
        failure_message: str,
        timeout_code: str,
        failure_status_code: int = 422,
    ) -> CommandResult:
        try:
            process = await asyncio.create_subprocess_exec(
                *arguments,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
        except (FileNotFoundError, PermissionError) as error:
            raise media_error(
                "MEDIA_TOOL_UNAVAILABLE", "The required media toolchain is unavailable.", 503
            ) from error

        if process.stdout is None or process.stderr is None:  # pragma: no cover - asyncio contract
            await self._stop_process(process)
            raise media_error(
                "MEDIA_TOOL_UNAVAILABLE", "Media process streams are unavailable.", 503
            )

        stdout_task = asyncio.create_task(
            self._drain_stream(process.stdout, self._settings.media_subprocess_output_limit_bytes)
        )
        stderr_task = asyncio.create_task(
            self._drain_stream(process.stderr, self._settings.media_subprocess_output_limit_bytes)
        )
        try:
            await asyncio.wait_for(process.wait(), timeout=timeout_seconds)
        except TimeoutError as error:
            await self._stop_process(process)
            await asyncio.gather(stdout_task, stderr_task)
            raise media_error(timeout_code, failure_message, 504) from error
        except asyncio.CancelledError:
            await self._stop_process(process)
            await asyncio.gather(stdout_task, stderr_task)
            raise

        stdout, stderr = await asyncio.gather(stdout_task, stderr_task)
        if process.returncode != 0:
            raise media_error(failure_code, failure_message, failure_status_code)
        return CommandResult(
            stdout=stdout.content,
            stderr=stderr.content,
            stdout_truncated=stdout.truncated,
            stderr_truncated=stderr.truncated,
        )

    @staticmethod
    async def _drain_stream(reader: asyncio.StreamReader, limit: int) -> _CapturedStream:
        captured = bytearray()
        truncated = False
        while chunk := await reader.read(65_536):
            remaining = limit - len(captured)
            if remaining > 0:
                captured.extend(chunk[:remaining])
            if len(chunk) > remaining:
                truncated = True
        return _CapturedStream(content=bytes(captured), truncated=truncated)

    @staticmethod
    async def _stop_process(process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
            return
        except TimeoutError:
            pass
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:  # pragma: no cover - benign race
            return
        await process.wait()
