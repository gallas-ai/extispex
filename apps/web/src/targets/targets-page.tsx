import type { Target } from "@extispex/contracts";
import { type FormEvent, useCallback, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { ApiCredentials } from "../api/api-request.ts";
import { createTarget, listTargets } from "../api/evaluation-api.ts";
import { useCanEditProject } from "../sign-in/access-context.ts";
import { AlertIcon, PlusIcon, TargetIcon } from "../ui/icons.tsx";
import { LoadError } from "../ui/load-error.tsx";
import { useApiResource } from "../ui/use-api-resource.ts";
import {
  type CredentialDraft,
  CredentialFields,
  NEW_CREDENTIAL_DRAFT,
} from "./credential-fields.tsx";
import { targetPagePath } from "./target-paths.ts";

interface TargetsPageProps {
  credentials: ApiCredentials;
  onSignInRequired: () => void;
}

export function TargetsPage({ credentials, onSignInRequired }: TargetsPageProps) {
  const canEdit = useCanEditProject();
  const loadTargets = useCallback(() => listTargets(credentials), [credentials]);
  const [targetsState, reloadTargets] = useApiResource(loadTargets);

  return (
    <div className="page page-constrained">
      <div className="page-header">
        <div className="page-heading">
          <h1>Targets</h1>
          <p className="page-subtitle">
            Your application as an HTTP endpoint, which Server-Driven Execution calls for each
            Iteration.
          </p>
        </div>
      </div>
      {canEdit && <NewTargetForm credentials={credentials} />}
      <section className="panel" aria-label="Target list">
        {targetsState.status === "loading" && <div className="panel-loading" aria-busy="true" />}
        {targetsState.status === "failed" && (
          <LoadError
            subject="Targets"
            message={targetsState.message}
            isSignInRequired={targetsState.isSignInRequired}
            onRetry={reloadTargets}
            onSignInRequired={onSignInRequired}
          />
        )}
        {targetsState.status === "loaded" && targetsState.resource.targets.length === 0 && (
          <div className="empty-state">
            <span className="empty-state-icon">
              <TargetIcon size={22} />
            </span>
            <h2>No Targets yet</h2>
            <p>
              A Target answers <code>POST {"{input, sessionId}"}</code> with{" "}
              <code>{"{output, correlationId, sessionId}"}</code>.
            </p>
          </div>
        )}
        {targetsState.status === "loaded" && targetsState.resource.targets.length > 0 && (
          <TargetTable targets={targetsState.resource.targets} />
        )}
      </section>
    </div>
  );
}

function NewTargetForm({ credentials }: { credentials: ApiCredentials }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [credential, setCredential] = useState<CredentialDraft>(NEW_CREDENTIAL_DRAFT);
  const [isCreating, setIsCreating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    if (name.trim() === "" || url.trim() === "") {
      setProblem("Give the Target a name and a URL.");
      return;
    }
    setIsCreating(true);
    setProblem(null);
    try {
      const target = await createTarget(credentials, {
        name: name.trim(),
        url: url.trim(),
        ...(credential.headerValue === "" ? {} : {
          credential: {
            headerName: credential.headerName.trim(),
            headerValue: credential.headerValue,
          },
        }),
      });
      navigate(targetPagePath(target.name));
    } catch (error) {
      setProblem((error as Error).message);
      setIsCreating(false);
    }
  };

  return (
    <section className="panel panel-form" aria-label="New Target">
      <form className="target-form" onSubmit={submit} noValidate>
        <div className="form-field-row">
          <div className="form-field">
            <label className="field-label" htmlFor="new-target-name">Name</label>
            <input
              id="new-target-name"
              className="text-input"
              placeholder="support-bot"
              autoComplete="off"
              spellCheck={false}
              value={name}
              onChange={(changeEvent) => setName(changeEvent.target.value)}
            />
          </div>
          <div className="form-field">
            <label className="field-label" htmlFor="new-target-url">URL</label>
            <input
              id="new-target-url"
              className="text-input text-input-mono"
              placeholder="https://agent.company.example/evaluate"
              autoComplete="off"
              spellCheck={false}
              value={url}
              onChange={(changeEvent) => setUrl(changeEvent.target.value)}
            />
          </div>
        </div>
        <CredentialFields
          idPrefix="new-target"
          draft={credential}
          valuePlaceholder="Optional, such as Bearer …"
          onChange={setCredential}
        />
        <p className="field-hint">
          The credential is stored encrypted and never shown again. The worker calls only the
          addresses that EVALUATION_TARGET_ALLOWED_DESTINATIONS allows.
        </p>
        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={isCreating}>
            <PlusIcon size={14} />
            Create Target
          </button>
        </div>
      </form>
      {problem !== null && (
        <p className="form-problem" role="alert">
          <AlertIcon size={14} />
          {problem}
        </p>
      )}
    </section>
  );
}

function TargetTable({ targets }: { targets: Target[] }) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Target</th>
            <th scope="col">URL</th>
            <th scope="col">Credential</th>
          </tr>
        </thead>
        <tbody>
          {targets.map((target) => (
            <tr key={target.name}>
              <td className="cell-breaks-anywhere">
                <Link to={targetPagePath(target.name)}>{target.name}</Link>
              </td>
              <td className="cell-breaks-anywhere">
                <code>{target.url}</code>
              </td>
              <td className="text-muted">{target.credentialHeaderName ?? "None"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
