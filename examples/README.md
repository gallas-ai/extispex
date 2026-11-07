# Examples

Each example sends a two-step support conversation, as an instrumented application would. Each step
has its own Correlation ID, and both steps share one Session ID. Start a local instance first (see
the [main README](../README.md)), then search for the printed Session ID in the UI.

| Example                                       | Run                                                                                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [TypeScript](typescript/send-conversation.ts) | `cd examples/typescript && deno task send-conversation`                                                                            |
| [Python](python/send_conversation.py)         | `cd examples/python && python -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/python send_conversation.py` |

Both need `API_KEY`, the API key of the Project to send to. A new instance logs the key of its first
Project, `Default`, on first start; create more under **Projects** in the UI. Both also read
`OTLP_HTTP_URL` (default `http://127.0.0.1:4318`).
