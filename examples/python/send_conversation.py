"""Sends a two-step support conversation as an instrumented Python application would.

Each step gets its own Correlation ID; both steps share one Session ID. The application owns
both values: the platform never generates them.

    python -m venv .venv && .venv/bin/pip install -r requirements.txt
    API_KEY=<your Project API key> .venv/bin/python send_conversation.py

Environment: API_KEY (required), the key of the Project to send to, and OTLP_HTTP_URL
(default http://127.0.0.1:4318).
"""

import os
import sys
import uuid
from contextlib import contextmanager

from opentelemetry import baggage, context
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

CORRELATION_ID_ATTRIBUTE = "correlation.id"
SESSION_ID_ATTRIBUTE = "session.id"


class TelemetryIdsSpanProcessor(SpanProcessor):
    """Copies the Correlation ID and Session ID from baggage onto every span when it starts."""

    def on_start(self, span, parent_context=None):
        for attribute_name in (CORRELATION_ID_ATTRIBUTE, SESSION_ID_ATTRIBUTE):
            attribute_value = baggage.get_baggage(attribute_name, parent_context)
            if attribute_value:
                span.set_attribute(attribute_name, str(attribute_value))


@contextmanager
def telemetry_ids(correlation_id, session_id=None):
    """Puts both IDs into baggage for every span created inside the `with` block."""
    ids_context = baggage.set_baggage(CORRELATION_ID_ATTRIBUTE, correlation_id)
    if session_id:
        ids_context = baggage.set_baggage(SESSION_ID_ATTRIBUTE, session_id, context=ids_context)
    context_token = context.attach(ids_context)
    try:
        yield
    finally:
        context.detach(context_token)


otlp_http_url = os.environ.get("OTLP_HTTP_URL", "http://127.0.0.1:4318")
api_key = os.environ.get("API_KEY")
if not api_key:
    sys.exit(
        "Set API_KEY to a Project API key. A new instance logs the key of its first Project on "
        "first start; more keys are created under Projects in the UI."
    )

tracer_provider = TracerProvider(resource=Resource.create({"service.name": "support-bot-python-example"}))
# Copies the IDs onto every span. It must run before the exporting processor.
tracer_provider.add_span_processor(TelemetryIdsSpanProcessor())
tracer_provider.add_span_processor(
    BatchSpanProcessor(
        OTLPSpanExporter(
            endpoint=f"{otlp_http_url}/v1/traces",
            headers={"authorization": f"Bearer {api_key}"},
        )
    )
)
tracer = tracer_provider.get_tracer("support-bot-python-example")


def answer_customer(customer_message):
    with tracer.start_as_current_span("handle-message"):
        with tracer.start_as_current_span("chat example-model") as llm_span:
            llm_span.set_attribute("gen_ai.request.model", "example-model")
            answer = f"Answer to: {customer_message}"
        with tracer.start_as_current_span("tool find_order"):
            pass
        return answer


session_id = f"support-chat-{uuid.uuid4()}"
for customer_message in ["Where is my order?", "Can I cancel it?"]:
    correlation_id = str(uuid.uuid4())
    with telemetry_ids(correlation_id, session_id):
        print(f"{answer_customer(customer_message)} (Correlation ID {correlation_id})")

tracer_provider.force_flush()
tracer_provider.shutdown()
print(f"Sent. Search for Session ID {session_id} in the UI.")
