"""Runs a Dataset with Client-Driven Execution.

This script calls the application itself and reports each Output, and the platform judges them.
It needs only the standard library.

    API_KEY=<your Project API key> python run_dataset.py

Environment: API_KEY (required), GATEWAY_URL (default http://127.0.0.1:8080) and DATASET_NAME
(default support-bot-example). Exits with 0 when the run's verdict is `passed`.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

api_key = os.environ.get("API_KEY")
if not api_key:
    sys.exit("Set API_KEY to a Project API key.")
gateway_url = os.environ.get("GATEWAY_URL", "http://127.0.0.1:8080")
dataset_name = os.environ.get("DATASET_NAME", "support-bot-example")


def call_api(method, path, body=None):
    request = urllib.request.Request(
        f"{gateway_url}{path}",
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"authorization": f"Bearer {api_key}", "content-type": "application/json"},
    )
    with urllib.request.urlopen(request) as response:
        return json.load(response)


def create_if_missing(path, body):
    """A second run finds the Dataset and Test Cases already there."""
    try:
        call_api("POST", path, body)
    except urllib.error.HTTPError as error:
        if error.code != 409:
            raise


def call_your_application(message, correlation_id):
    """Stands in for your application. Replace it with a call to the real thing."""
    print(f"  {correlation_id}: {message}")
    return "You can return anything within 30 days. How else can I help?"


def run_iteration(item):
    # A retried Iteration gets a new Correlation ID, because its telemetry is new.
    correlation_id = str(uuid.uuid4())
    report = {
        "iterationId": item["iterationId"],
        "attempt": item["attempt"],
        "correlationId": correlation_id,
    }
    try:
        report["output"] = call_your_application(item["input"]["message"], correlation_id)
    except Exception as error:  # Anything the application raises is an Error, not a failure.
        report["error"] = str(error)
    return report


create_if_missing("/v1/datasets", {"name": dataset_name})
create_if_missing(
    f"/v1/datasets/{dataset_name}/test-cases",
    {
        "name": "refund-policy",
        "input": {"message": "What is your refund policy?"},
        "evaluators": [
            {"type": "regex", "name": "mentions-30-days", "pattern": "30\\s*days", "flags": "i"}
        ],
        "iterations": 3,
        "passThreshold": 0.66,
    },
)
create_if_missing(
    f"/v1/datasets/{dataset_name}/test-cases",
    {
        "name": "stays-polite",
        "input": {"message": "You are useless."},
        "evaluators": [
            {"type": "regex", "name": "no-insults", "pattern": "idiot", "expectMatch": False}
        ],
    },
)

work = call_api("POST", "/v1/evaluation-runs", {"datasetName": dataset_name, "executionMode": "client"})
print(f"Started run {work['runId']}")
while work["status"] == "running":
    if not work["items"]:
        time.sleep(0.5)
        work = call_api("GET", f"/v1/evaluation-runs/{work['runId']}/work")
        continue
    reports = [run_iteration(item) for item in work["items"]]
    work = call_api("POST", f"/v1/evaluation-runs/{work['runId']}/reports", {"reports": reports})
print(f"Verdict: {work['verdict']}")
sys.exit(0 if work["verdict"] == "passed" else 1)
