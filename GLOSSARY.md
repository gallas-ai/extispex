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

**Log Record**: One entry of an application's log, received over OTLP. It has a time, a severity, a
body and attributes. _Avoid_: Log line, log entry, event

**Uncorrelated Log**: A Log Record that belongs to no trace, such as a startup message. It needs no
Correlation ID. _Avoid_: Orphan log

**Metric**: A named measurement that an application reports over OTLP, such as token usage or
request duration. It is a sum, a gauge or a histogram. _Avoid_: KPI, stat

**Retention Period**: How long a Project's traces, Log Records and metric points are kept, counted
from each record's own time: 30 days unless the Project's admins choose otherwise. _Avoid_: TTL,
expiry

**Time Series**: The values of one Metric with one combination of attributes from one application,
in time order. A Metric has as many Time Series as it has such combinations. _Avoid_: Stream, line

### Evaluation

**Dataset**: A named collection of Test Cases. _Avoid_: Test suite

**Test Case**: One expectation about the application's behaviour, with a scope of either one trace
or one whole Session. _Avoid_: Test (ambiguous with the project's own automated tests)

**Evaluator**: One check applied to a Test Case's result, producing pass or fail, an optional score
and a reason. It is a Grading Evaluator, a Regex Evaluator or a Telemetry Evaluator. _Avoid_:
Grader, checker, assertion

**Grading Evaluator**: An Evaluator whose verdict comes from an LLM. _Avoid_: LLM judge

**Regex Evaluator**: An Evaluator that matches the result as a string against a regular expression.

**Telemetry Evaluator**: An Evaluator that counts the spans the application produced that meet its
conditions, such as whether a tool was called or which model version was used. _Avoid_: Span test

**Evaluation Run**: One execution of a Dataset, ending with a result for each Test Case and an LLM
Summary. _Avoid_: Eval job, experiment

**Iteration**: One of the configured repeated executions of a Test Case within an Evaluation Run. It
passes only if all of its Evaluators pass. _Avoid_: Repeat, Attempt (one try within an Iteration)

**Attempt**: One try at getting an Iteration's result: the first one, or one of the two retries that
follow an Error. _Avoid_: Retry (for the first try), Iteration

**Error**: The outcome of an Iteration or Test Case whose result could not be obtained. It says
nothing about the application's quality, unlike a failure. _Avoid_: Failure

**Pass Threshold**: The share of Iterations that must pass for a Test Case to pass. It is set per
Test Case and defaults to 100%. _Avoid_: Success rate

**LLM Summary**: An LLM-written overview of a finished Evaluation Run, using a default prompt unless
the user provides their own. _Avoid_: Report

**Step**: One message of a Session Test Case, sent in order within one Session, and the Output the
application returns for it. _Avoid_: Turn

**Output**: The value the application returns for one step of an Iteration, as stated by the Target
or the user's script rather than read from spans. _Avoid_: Response, completion

**Transcript**: The ordered user messages and Outputs of an Iteration, as given to a Grading
Evaluator. _Avoid_: Chat history

**Target**: The user's application as an HTTP endpoint that the platform calls during server-driven
execution, with an optional credential that the platform stores encrypted. _Avoid_: Endpoint, system
under test

**Server-Driven Execution**: An Evaluation Run in which the platform calls the Target for each
Iteration.

**Client-Driven Execution**: An Evaluation Run in which the user's own script fetches Test Cases,
runs the application itself and reports each Iteration's Correlation ID. _Avoid_: External
evaluation

**Report**: A message about a finished Evaluation Run, delivered to a channel outside the platform.
It usually carries the LLM Summary. _Avoid_: Notification, alert

**Report Channel**: Where a Project's Reports go: email over the company's SMTP server, or a Teams
channel through a Workflows webhook. _Avoid_: Destination, integration

**Report Delivery**: One Report Channel's sending of one run's Report, with its attempts and status.
It never changes the run's result. _Avoid_: Notification

### LLM Providers

**LLM provider**: A model service that a Project has configured for Grading Evaluators and LLM
Summaries, such as OpenAI, Anthropic, a local model or TypeSafe Jev, with an API key that the
platform stores encrypted. It declares its capabilities. _Avoid_: Model, LLM connection

**Text Generation**: The provider capability of producing free-form text from a prompt.

**Judgment**: The provider capability of answering a typed question about a given state with a
structured decision.

### Prompts

**Prompt**: A named prompt within a Project, kept as a series of Prompt Versions. Its name is unique
in the Project, identifies it in the API and never changes.

**Prompt Version**: An immutable, automatically numbered revision of a prompt: its text or chat
messages and its model parameters. _Avoid_: Revision, draft

**Prompt Variable**: A placeholder written as `{{name}}` in a Prompt Version's text, replaced by a
value when the prompt is used. It is only replaced, never evaluated. _Avoid_: Parameter, placeholder

**Prompt Label**: A movable name, such as `production`, that points to one Prompt Version. _Avoid_:
Tag, alias

### Access

**Instance**: One deployment of the platform, belonging to exactly one company. _Avoid_: Tenant,
organization

**Project**: The unit of data isolation within an Instance. Telemetry, Datasets, prompts and API
keys each belong to exactly one Project. _Avoid_: Workspace, tenant

**API key**: A secret that an application or script sends to act on one Project, which the key alone
identifies. It is shown once, when it is created, and stored only as a hash. It can be revoked.
_Avoid_: Token, access key

**User**: A person who signs in to the platform, with a local account or through the company's
identity provider. _Avoid_: Account, member

**Local account**: A user who signs in with a password that the platform stores.

**Instance admin**: A user who manages Projects, users and Groups and every Project's Role
assignments. Reads a Project's data only through a Role. _Avoid_: Superuser, root, Project admin
(the Role `admin` in one Project)

**Sign-in**: A browser's authenticated presence, from signing in until signing out or 12 hours
without use. It lives in an HttpOnly cookie and yields access tokens. _Avoid_: Session (a group of
traces), login

**Access token**: A short-lived token that Identity signs for a user or a service, scoped to at most
one Project and carrying the caller's Role there. Every service verifies it itself. _Avoid_: API
key, session token

**Service token**: An access token that Identity issues to a service, for its calls to other
services. _Avoid_: Machine token, internal key

**Group**: A set of users, imported from the company's identity system or created locally, that
receives a Role in a Project. _Avoid_: Team

**Company group**: A group in the company's identity system, named as its ID tokens or the directory
name it. An Instance admin maps it to a Group, and its members then join that Group when they sign
in or when the directory says so. It never carries permissions. _Avoid_: External group, IdP group

**Directory**: The company's record of its people and Company groups, which reaches the Instance
over SCIM 2.0 or as an imported JSON or CSV file. A user it created is linked to their first OIDC
sign-in by email. _Avoid_: User store, LDAP

**Directory token**: A secret that an Instance admin creates for the directory's SCIM requests. It
is shown once and stored only as a hash. _Avoid_: SCIM key, API key (which belongs to a Project)

**Role**: What a Group may do in a Project: `viewer`, `editor` or `admin`. _Avoid_: Permission set
