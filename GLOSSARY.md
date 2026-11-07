# Extispex

A self-hosted platform for observing and evaluating GenAI applications and agents. It stores their
telemetry and judges their behaviour against user-defined expectations.

## Language

### Observability

**Correlation ID**: A business identifier that the user's application assigns to its telemetry so
that it can always be looked up. It is not unique: retrying the same operation produces several
traces with the same Correlation ID. _Avoid_: Custom ID, user ID, request ID

**Session**: A group of traces that form one conversation, identified by a value the user's
application assigns. It exists as soon as its first trace arrives and has no explicit start or end.
_Avoid_: Conversation, thread

### Evaluation

**Dataset**: A named collection of Test Cases. _Avoid_: Test suite

**Test Case**: One expectation about the application's behaviour, with a scope of either one trace
or one whole Session. _Avoid_: Test (ambiguous with the project's own automated tests)

**Evaluator**: One check applied to a Test Case's result, producing pass or fail, an optional score
and a reason. It is a Grading Evaluator, a Regex Evaluator or a Telemetry Evaluator. _Avoid_:
Grader, checker, assertion

**Grading Evaluator**: An Evaluator whose verdict comes from an LLM. _Avoid_: LLM judge

**Regex Evaluator**: An Evaluator that matches the result as a string against a regular expression.

**Telemetry Evaluator**: An Evaluator that inspects the spans the application produced, such as
whether a tool was called or which model version was used. _Avoid_: Span test

**Evaluation Run**: One execution of a Dataset, ending with a result for each Test Case and an LLM
Summary. _Avoid_: Eval job, experiment

**Iteration**: One of the configured repeated executions of a Test Case within an Evaluation Run. It
passes only if all of its Evaluators pass. _Avoid_: Repeat, attempt

**Error**: The outcome of an Iteration or Test Case whose result could not be obtained. It says
nothing about the application's quality, unlike a failure. _Avoid_: Failure

**Pass Threshold**: The share of Iterations that must pass for a Test Case to pass. It is set per
Test Case and defaults to 100%. _Avoid_: Success rate

**LLM Summary**: An LLM-written overview of a finished Evaluation Run, using a default prompt unless
the user provides their own. _Avoid_: Report

**Output**: The value the application returns for one step of an Iteration, as stated by the Target
or the user's script rather than read from spans. _Avoid_: Response, completion

**Transcript**: The ordered user messages and Outputs of an Iteration, as given to a Grading
Evaluator. _Avoid_: Chat history

**Target**: The user's application as an HTTP endpoint that the platform calls during server-driven
execution. _Avoid_: Endpoint, system under test

**Server-Driven Execution**: An Evaluation Run in which the platform calls the Target for each
Iteration.

**Client-Driven Execution**: An Evaluation Run in which the user's own script fetches Test Cases,
runs the application itself and reports each Iteration's Correlation ID. _Avoid_: External
evaluation

**Report**: A message about a finished Evaluation Run, delivered to a channel outside the platform.
It usually carries the LLM Summary. _Avoid_: Notification, alert

### LLM Providers

**Text Generation**: The provider capability of producing free-form text from a prompt.

**Judgment**: The provider capability of answering a typed question about a given state with a
structured decision.

### Prompts

**Prompt Version**: An immutable, automatically numbered revision of a prompt, including its model
parameters. _Avoid_: Revision, draft

**Prompt Label**: A movable name, such as `production`, that points to one Prompt Version. _Avoid_:
Tag, alias

### Access

**Instance**: One deployment of the platform, belonging to exactly one company. _Avoid_: Tenant,
organization

**Project**: The unit of data isolation within an Instance. Telemetry, Datasets, prompts and API
keys each belong to exactly one Project. _Avoid_: Workspace, tenant

**Group**: A set of users, imported from the company's identity system or created locally, that
receives a Role in a Project. _Avoid_: Team

**Role**: What a Group may do in a Project: `viewer`, `editor` or `admin`. _Avoid_: Permission set
