import type {
  ReportCondition,
  ReportSettings,
  SmtpSecurity,
  UpdateReportSettingsRequest,
} from "@extispex/contracts";
import { type FormEvent, useCallback, useState } from "react";
import type { ApiCredentials } from "../api/api-request.ts";
import { getReportSettings, updateReportSettings } from "../api/evaluation-api.ts";
import { Breadcrumbs } from "../prompts/prompt-parts.tsx";
import { useCanEditProject } from "../sign-in/access-context.ts";
import { AlertIcon, CheckIcon } from "../ui/icons.tsx";
import { LoadError } from "../ui/load-error.tsx";
import { useApiResource } from "../ui/use-api-resource.ts";

export const REPORT_SETTINGS_PATH = "/report-settings";

interface ReportSettingsPageProps {
  credentials: ApiCredentials;
  onSignInRequired: () => void;
}

/** The usual port for each kind of SMTP security. */
const DEFAULT_SMTP_PORTS: Record<SmtpSecurity, number> = { tls: 465, starttls: 587, none: 25 };

const SECURITY_LABELS: Record<SmtpSecurity, string> = {
  starttls: "STARTTLS, required",
  tls: "TLS from the start",
  none: "None, inside the company's network",
};

const CONDITION_LABELS: Record<ReportCondition, string> = {
  always: "Every finished run",
  on_failure: "Only runs that did not pass",
};

/** Where a Project's Reports go when an Evaluation Run finishes. */
export function ReportSettingsPage({ credentials, onSignInRequired }: ReportSettingsPageProps) {
  const loadSettings = useCallback(() => getReportSettings(credentials), [credentials]);
  const [settingsState, reloadSettings] = useApiResource(loadSettings);

  return (
    <div className="page page-constrained">
      <Breadcrumbs
        items={[{ label: "Evaluation Runs", path: "/evaluation-runs" }, { label: "Reports" }]}
      />
      <div className="page-header">
        <div className="page-heading">
          <h1>Report settings</h1>
          <p className="page-subtitle">
            A finished Evaluation Run sends a Report by email or to a Teams channel. Delivery
            problems never change the run's result.
          </p>
        </div>
      </div>
      {settingsState.status === "loading" && (
        <section className="panel">
          <div className="panel-loading" aria-busy="true" />
        </section>
      )}
      {settingsState.status === "failed" && (
        <section className="panel">
          <LoadError
            subject="The Report settings"
            message={settingsState.message}
            isSignInRequired={settingsState.isSignInRequired}
            onRetry={reloadSettings}
            onSignInRequired={onSignInRequired}
          />
        </section>
      )}
      {settingsState.status === "loaded" && (
        <ReportSettingsForm credentials={credentials} initialSettings={settingsState.resource} />
      )}
    </div>
  );
}

/** Addresses separated by commas, semicolons or line breaks. */
function parseRecipients(text: string): string[] {
  return text.split(/[\s,;]+/).map((address) => address.trim()).filter(Boolean);
}

function ReportSettingsForm(
  { credentials, initialSettings }: {
    credentials: ApiCredentials;
    initialSettings: ReportSettings;
  },
) {
  const canEdit = useCanEditProject();
  // What the server holds now; the secrets' fields stay empty to keep them.
  const [settings, setSettings] = useState(initialSettings);
  const storedEmail = settings.email;
  const [condition, setCondition] = useState<ReportCondition>(settings.condition);
  const [isEmailOn, setIsEmailOn] = useState(storedEmail !== null);
  const [smtpHost, setSmtpHost] = useState(storedEmail?.smtpHost ?? "");
  const [smtpSecurity, setSmtpSecurity] = useState<SmtpSecurity>(
    storedEmail?.smtpSecurity ?? "starttls",
  );
  const [smtpPort, setSmtpPort] = useState(String(storedEmail?.smtpPort ?? 587));
  const [smtpUsername, setSmtpUsername] = useState(storedEmail?.smtpUsername ?? "");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [fromAddress, setFromAddress] = useState(storedEmail?.fromAddress ?? "");
  const [recipients, setRecipients] = useState(storedEmail?.recipients.join("\n") ?? "");
  const [isTeamsOn, setIsTeamsOn] = useState(settings.teams !== null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [isSaved, setIsSaved] = useState(false);
  const hasStoredPassword = storedEmail?.hasSmtpPassword === true;

  const chooseSecurity = (security: SmtpSecurity) => {
    // Keep a port someone typed, but follow the usual one when it was the old default.
    if (smtpPort === String(DEFAULT_SMTP_PORTS[smtpSecurity])) {
      setSmtpPort(String(DEFAULT_SMTP_PORTS[security]));
    }
    setSmtpSecurity(security);
  };

  const submit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    setProblem(null);
    setIsSaved(false);
    const username = smtpUsername.trim();
    const request: UpdateReportSettingsRequest = {
      condition,
      email: isEmailOn
        ? {
          smtpHost: smtpHost.trim(),
          smtpPort: Number(smtpPort),
          smtpSecurity,
          smtpUsername: username === "" ? null : username,
          // An empty field keeps the stored password; without a user name there is none.
          ...(username === ""
            ? { smtpPassword: null }
            : smtpPassword === ""
            ? {}
            : { smtpPassword }),
          fromAddress: fromAddress.trim(),
          recipients: parseRecipients(recipients),
        }
        : null,
      teams: isTeamsOn ? (webhookUrl.trim() === "" ? {} : { webhookUrl: webhookUrl.trim() }) : null,
    };
    try {
      setSettings(await updateReportSettings(credentials, request));
      setSmtpPassword("");
      setWebhookUrl("");
      setIsSaved(true);
    } catch (error) {
      setProblem((error as Error).message);
    }
  };

  return (
    <form className="form-card report-settings-form" onSubmit={submit} noValidate>
      <div className="form-field">
        <span className="field-label" id="report-condition-label">Send a Report for</span>
        <div
          className="segmented-control segmented-control-text report-condition-control"
          role="radiogroup"
          aria-labelledby="report-condition-label"
        >
          {(["always", "on_failure"] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={condition === choice}
              className="segmented-control-option"
              disabled={!canEdit}
              onClick={() => setCondition(choice)}
            >
              {CONDITION_LABELS[choice]}
            </button>
          ))}
        </div>
        <p className="field-hint">A run that ended with an Error did not pass either.</p>
      </div>

      <fieldset className="report-channel" aria-label="Email">
        <label className="checkbox-label report-channel-switch">
          <input
            type="checkbox"
            checked={isEmailOn}
            disabled={!canEdit}
            onChange={(changeEvent) => setIsEmailOn(changeEvent.target.checked)}
          />
          Send by email
        </label>
        {isEmailOn && (
          <>
            <div className="form-field-row report-smtp-row">
              <div className="form-field">
                <label className="field-label" htmlFor="report-smtp-host">SMTP host</label>
                <input
                  id="report-smtp-host"
                  className="text-input text-input-mono"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="smtp.company.example"
                  disabled={!canEdit}
                  value={smtpHost}
                  onChange={(changeEvent) => setSmtpHost(changeEvent.target.value)}
                />
              </div>
              <div className="form-field">
                <label className="field-label" htmlFor="report-smtp-port">Port</label>
                <input
                  id="report-smtp-port"
                  className="text-input text-input-mono"
                  inputMode="numeric"
                  disabled={!canEdit}
                  value={smtpPort}
                  onChange={(changeEvent) => setSmtpPort(changeEvent.target.value)}
                />
              </div>
            </div>
            <div className="form-field">
              <label className="field-label" htmlFor="report-smtp-security">Security</label>
              <select
                id="report-smtp-security"
                className="select-input"
                disabled={!canEdit}
                value={smtpSecurity}
                onChange={(changeEvent) => chooseSecurity(changeEvent.target.value as SmtpSecurity)}
              >
                {(["starttls", "tls", "none"] as const).map((security) => (
                  <option key={security} value={security}>{SECURITY_LABELS[security]}</option>
                ))}
              </select>
            </div>
            <div className="form-field-row report-smtp-row">
              <div className="form-field">
                <label className="field-label" htmlFor="report-smtp-username">User name</label>
                <input
                  id="report-smtp-username"
                  className="text-input"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Leave empty without sign-in"
                  disabled={!canEdit}
                  value={smtpUsername}
                  onChange={(changeEvent) => setSmtpUsername(changeEvent.target.value)}
                />
              </div>
              <div className="form-field">
                <label className="field-label" htmlFor="report-smtp-password">Password</label>
                <input
                  id="report-smtp-password"
                  className="text-input"
                  type="password"
                  autoComplete="new-password"
                  placeholder={hasStoredPassword ? "Stored; leave empty to keep" : ""}
                  disabled={!canEdit || smtpUsername.trim() === ""}
                  value={smtpPassword}
                  onChange={(changeEvent) => setSmtpPassword(changeEvent.target.value)}
                />
              </div>
            </div>
            {hasStoredPassword && (
              <p className="status-text">The SMTP password is stored encrypted.</p>
            )}
            <div className="form-field">
              <label className="field-label" htmlFor="report-from-address">From</label>
              <input
                id="report-from-address"
                className="text-input"
                type="email"
                autoComplete="off"
                placeholder="extispex@company.example"
                disabled={!canEdit}
                value={fromAddress}
                onChange={(changeEvent) => setFromAddress(changeEvent.target.value)}
              />
            </div>
            <div className="form-field">
              <label className="field-label" htmlFor="report-recipients">Recipients</label>
              <textarea
                id="report-recipients"
                className="text-area"
                rows={3}
                spellCheck={false}
                placeholder="One address per line"
                disabled={!canEdit}
                value={recipients}
                onChange={(changeEvent) => setRecipients(changeEvent.target.value)}
              />
            </div>
          </>
        )}
      </fieldset>

      <fieldset className="report-channel" aria-label="Teams">
        <label className="checkbox-label report-channel-switch">
          <input
            type="checkbox"
            checked={isTeamsOn}
            disabled={!canEdit}
            onChange={(changeEvent) => setIsTeamsOn(changeEvent.target.checked)}
          />
          Post to Teams
        </label>
        {isTeamsOn && (
          <div className="form-field">
            <label className="field-label" htmlFor="report-webhook-url">Webhook URL</label>
            <input
              id="report-webhook-url"
              className="text-input text-input-mono"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={settings.teams === null
                ? "https://…logic.azure.com/workflows/…"
                : "Stored; leave empty to keep"}
              disabled={!canEdit}
              value={webhookUrl}
              onChange={(changeEvent) => setWebhookUrl(changeEvent.target.value)}
            />
            <p className="field-hint">
              {settings.teams === null
                ? 'From a Teams workflow that starts "When a Teams webhook request is received".'
                : `A webhook URL on ${settings.teams.webhookHost} is stored encrypted.`}
            </p>
          </div>
        )}
      </fieldset>

      {problem !== null && (
        <p className="form-problem" role="alert">
          <AlertIcon size={14} />
          {problem}
        </p>
      )}
      {isSaved && (
        <p className="form-success" role="status">
          <CheckIcon size={14} /> Saved.
        </p>
      )}
      {canEdit && (
        <div className="form-actions">
          <button type="submit" className="button button-primary">Save Report settings</button>
        </div>
      )}
    </form>
  );
}
