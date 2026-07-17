# syntax=docker/dockerfile:1.7
ARG PYTHON_IMAGE=python:3.12-slim-bookworm
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.11.28

FROM ${UV_IMAGE} AS uv

FROM ${PYTHON_IMAGE} AS build
ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy
WORKDIR /app

COPY --from=uv /uv /uvx /bin/
COPY services/ai/pyproject.toml services/ai/uv.lock services/ai/README.md ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev --no-install-project

COPY services/ai/src ./src
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev --no-editable

FROM ${PYTHON_IMAGE} AS runtime
ENV PATH=/app/.venv/bin:${PATH}
ENV PYTHONUNBUFFERED=1
WORKDIR /app

RUN apt-get update \
    && apt-get install --no-install-recommends --yes ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 voiceverse \
    && useradd --system --uid 10001 --gid voiceverse voiceverse \
    && install -d -o voiceverse -g voiceverse -m 0700 /var/lib/voiceverse-media \
    && install -d -o voiceverse -g voiceverse -m 0700 /var/lib/voiceverse-speech
COPY --from=build --chown=voiceverse:voiceverse /app/.venv ./.venv

USER voiceverse
EXPOSE 8000
CMD ["uvicorn", "voiceverse_ai.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
