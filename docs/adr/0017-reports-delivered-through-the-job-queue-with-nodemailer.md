---
status: accepted
---

# Reports are delivered through the job queue, one row per channel, and email goes through nodemailer

When an Evaluation Run finishes, the transaction that sets its verdict also inserts one row in
`report_deliveries` for each Report Channel that the Project's settings ask for, and the jobs are
queued after commit. The worker claims a row with one conditional update, sends the Report, and
records the outcome on the row. A failure schedules the next attempt itself, as a delayed job, after
1, 4, 16 and 64 minutes, and the fifth failure ends the delivery as `failed`. The run's own rows are
never touched, so a delivery cannot change the run's result.

```text
finalizeRunIfComplete ── insert report_deliveries (pending) ──► queue deliver-report jobs
worker: claim (pending → sending, attempt + 1) ── send ──► delivered
                                                     └──► pending, due in 4^(n-1) min ──► delayed job
maintenance: pending or sending and due more than 2 min ago ──► queue again
```

Email goes over the customer's SMTP server with [nodemailer](https://nodemailer.com) 10.5.0, which
has no dependencies, ships its own types and runs on Deno through `npm:`. The worker resolves the
SMTP host itself, checks every address against `EVALUATION_REPORT_ALLOWED_DESTINATIONS`, and hands
nodemailer the checked address with the configured name as the TLS server name, so a DNS change
cannot redirect the connection and the certificate is still checked against the name. Teams gets an
Adaptive Card through the same request code as Targets.

## Considered Options

- **A row per delivery, retries scheduled by the worker (chosen):** the run page reads the status of
  each channel from the row, retries can wait far longer than the queue's own one-second retry, and
  a lost job is found again by the maintenance task, as stalled attempts are.
- **Rely on the queue's retries alone:** pg-boss and the SQLite queue retry twice after one second,
  which an SMTP server that is restarting does not survive, and the status would be invisible.
- **Send directly when the run finishes:** the run finishes inside a request or a job transaction; a
  slow SMTP server would hold the run's lock, and a crash would lose the Report.
- **Our own SMTP client:** about 300 lines for EHLO, STARTTLS, AUTH and dot-stuffing, plus MIME
  multipart, quoted-printable and encoded headers. Every one of these has known edge cases that
  nodemailer has handled for years.

## Consequences

- A worker that dies after the SMTP server accepted a message but before the row was updated sends
  the Report again after two minutes. A duplicate Report was preferred to a lost one.
- An SMTP server or webhook that users enter is an outbound request like a Target, so separate
  services send nothing until an operator lists the destinations; the local image allows any.
- Test servers run in the test process: `@extispex/service-runtime/fake-smtp-server` speaks enough
  SMTP for nodemailer, so CI needs no extra container.
- Replacing nodemailer touches only `services/evaluation/src/reports/report-sender.ts`.
