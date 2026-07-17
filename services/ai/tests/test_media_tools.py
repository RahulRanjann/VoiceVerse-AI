import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from voiceverse_ai.core.config import Settings
from voiceverse_ai.media.errors import MediaExecutionError
from voiceverse_ai.media.tools import MediaToolchain


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_subprocess_capture_is_capped_and_timeout_kills_process_group() -> None:
    toolchain = MediaToolchain(
        Settings(environment="test", media_subprocess_output_limit_bytes=4096)
    )
    captured = await toolchain._run_command(
        [sys.executable, "-c", "print('x' * 10000)"],
        timeout_seconds=5,
        failure_code="TEST_FAILED",
        failure_message="test failed",
        timeout_code="TEST_TIMEOUT",
    )
    assert len(captured.stdout) == 4096
    assert captured.stdout_truncated

    with pytest.raises(MediaExecutionError) as caught:
        await toolchain._run_command(
            [sys.executable, "-c", "import time; time.sleep(5)"],
            timeout_seconds=1,
            failure_code="TEST_FAILED",
            failure_message="test failed",
            timeout_code="TEST_TIMEOUT",
        )
    assert caught.value.code == "TEST_TIMEOUT"
    assert caught.value.status_code == 504


@pytest.mark.anyio
async def test_missing_media_tool_has_stable_failure() -> None:
    toolchain = MediaToolchain(
        Settings(
            environment="test",
            ffmpeg_binary="voiceverse-no-such-ffmpeg",
            ffprobe_binary="voiceverse-no-such-ffprobe",
        )
    )
    assert not toolchain.is_ready()
    with pytest.raises(MediaExecutionError, match="MEDIA_TOOL_UNAVAILABLE"):
        await toolchain.versions()

    if Path("/usr/bin/false").exists():
        with pytest.raises(MediaExecutionError) as nonzero:
            await toolchain._run_command(
                ["/usr/bin/false"],
                timeout_seconds=5,
                failure_code="MEDIA_TOOL_UNAVAILABLE",
                failure_message="tool unavailable",
                timeout_code="MEDIA_TOOL_UNAVAILABLE",
                failure_status_code=503,
            )
        assert nonzero.value.status_code == 503


@pytest.mark.anyio
@pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="FFmpeg integration requires local ffmpeg and ffprobe binaries",
)
async def test_real_toolchain_probes_and_generates_expected_flac_derivatives(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.wav"
    canonical = tmp_path / "canonical.flac"
    analysis = tmp_path / "analysis.flac"
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=1000:duration=0.1",
            "-ac",
            "2",
            str(source),
        ],
        check=True,
    )
    toolchain = MediaToolchain(Settings(environment="test"))

    source_probe = await toolchain.probe(source)
    await toolchain.transcode_audio(
        source=source,
        stream_index=0,
        canonical_output=canonical,
        analysis_output=analysis,
    )
    canonical_probe = await toolchain.probe(canonical)
    analysis_probe = await toolchain.probe(analysis)
    ffmpeg_version, ffprobe_version = await toolchain.versions()

    assert source_probe["streams"][0]["codec_type"] == "audio"
    assert canonical_probe["streams"][0]["sample_rate"] == "48000"
    assert canonical_probe["streams"][0]["channels"] == 2
    assert analysis_probe["streams"][0]["sample_rate"] == "16000"
    assert analysis_probe["streams"][0]["channels"] == 1
    assert ffmpeg_version and ffprobe_version
