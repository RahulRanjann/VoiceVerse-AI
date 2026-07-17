class MediaExecutionError(Exception):
    """A safe, stable failure returned to the trusted control plane."""

    def __init__(self, *, code: str, message: str, status_code: int) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.status_code = status_code


def media_error(code: str, message: str, status_code: int) -> MediaExecutionError:
    return MediaExecutionError(code=code, message=message, status_code=status_code)
