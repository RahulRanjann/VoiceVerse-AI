from voiceverse_ai.media.errors import MediaExecutionError


class SpeechExecutionError(MediaExecutionError):
    """A stable, sanitized speech-execution failure for the control plane."""


def speech_error(code: str, message: str, status_code: int) -> SpeechExecutionError:
    return SpeechExecutionError(code=code, message=message, status_code=status_code)
