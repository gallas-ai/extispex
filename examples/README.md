# Examples

Each example sends a two-step support conversation, as an instrumented application would. Each step
has its own Correlation ID, and both steps share one Session ID. Start a local instance first (see
the [main README](../README.md)), then search for the printed Session ID in the UI.

| Example                                       | Run                                                                                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [TypeScript](typescript/send-conversation.ts) | `cd examples/typescript && deno task send-conversation`                                                                            |
| [Python](python/send_conversation.py)         | `cd examples/python && python -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/python send_conversation.py` |

Both read `OTLP_HTTP_URL` (default `http://127.0.0.1:4318`) and `API_KEY` (default
`local-development-key`).
