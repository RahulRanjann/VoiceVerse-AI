from voiceverse_ai.media.errors import MediaExecutionError


class TranslationExecutionError(MediaExecutionError):
    """A stable, sanitized translation failure for the control plane."""


def translation_error(code: str, message: str, status_code: int) -> TranslationExecutionError:
    return TranslationExecutionError(code=code, message=message, status_code=status_code)
