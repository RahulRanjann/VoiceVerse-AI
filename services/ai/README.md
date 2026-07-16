# VoiceVerse AI execution plane

This service owns AI and media execution concerns. It does not own users, billing, project authorization, or authoritative workflow state.

```bash
uv sync --all-groups
uv run uvicorn voiceverse_ai.main:app --reload --port 8000
```

Model dependencies are added only with the pipeline stage that consumes them. This keeps the base service fast to build and avoids locking incompatible GPU stacks prematurely.
