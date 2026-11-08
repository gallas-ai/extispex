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

## Client-Driven Execution

Each example creates a small Dataset, starts an Evaluation Run, calls a stand-in for your
application for each Iteration and reports the Outputs. The platform judges them with Regex
Evaluators. The script exits with 0 when the run's verdict is `passed`, so it can gate a CI job.
Open **Runs** in the UI to see the results.

| Example                                 | Run                                               |
| --------------------------------------- | ------------------------------------------------- |
| [TypeScript](typescript/run-dataset.ts) | `cd examples/typescript && deno task run-dataset` |
| [Python](python/run_dataset.py)         | `cd examples/python && python run_dataset.py`     |

Both need `API_KEY`, and read `GATEWAY_URL` (default `http://127.0.0.1:8080`) and `DATASET_NAME`
(default `support-bot-example`).
