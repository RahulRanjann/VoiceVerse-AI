import logging
import sys

import structlog


def configure_logging(level: str) -> None:
    """Configure JSON logs suitable for stdout collection.

    Transcript text, signed URLs, credentials, and raw model inputs must never be
    passed to log calls. Identifiers and aggregate timings are safe defaults.
    """

    logging.basicConfig(format="%(message)s", level=level.upper(), stream=sys.stdout)
    structlog.configure(
        cache_logger_on_first_use=True,
        logger_factory=structlog.stdlib.LoggerFactory(),
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.stdlib.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
    )
