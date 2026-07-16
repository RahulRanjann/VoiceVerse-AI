from collections.abc import Callable

from fastapi import FastAPI
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from voiceverse_ai.core.config import Settings


def configure_telemetry(app: FastAPI, settings: Settings) -> Callable[[], None]:
    if settings.otel_traces_exporter == "none":
        return lambda: None

    provider = TracerProvider(
        resource=Resource.create(
            {
                "service.name": "voiceverse-ai-service",
                "service.namespace": settings.otel_service_namespace,
                "service.version": settings.app_version,
            }
        )
    )
    exporter = OTLPSpanExporter(
        endpoint=f"{str(settings.otel_exporter_otlp_endpoint).rstrip('/')}/v1/traces"
    )
    provider.add_span_processor(BatchSpanProcessor(exporter))
    FastAPIInstrumentor.instrument_app(app, tracer_provider=provider)

    def shutdown() -> None:
        FastAPIInstrumentor.uninstrument_app(app)
        provider.shutdown()

    return shutdown
