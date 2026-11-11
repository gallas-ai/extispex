import type { Target } from "@extispex/contracts";
import { type FormEvent, useCallback, useState } from "react";
import { useNavigate, useParams } from "react-router";
import type { ApiCredentials } from "../api/api-request.ts";
import { deleteTarget, getTarget, updateTarget } from "../api/evaluation-api.ts";
import { Breadcrumbs } from "../prompts/prompt-parts.tsx";
import { useCanEditProject } from "../sign-in/access-context.ts";
import { AlertIcon, CheckIcon, TrashIcon } from "../ui/icons.tsx";
import { LoadError } from "../ui/load-error.tsx";
import { useApiResource } from "../ui/use-api-resource.ts";
import {
  type CredentialDraft,
  CredentialFields,
  NEW_CREDENTIAL_DRAFT,
} from "./credential-fields.tsx";

interface TargetPageProps {
  credentials: ApiCredentials;
  onSignInRequired: () => void;
}

export function TargetPage({ credentials, onSignInRequired }: TargetPageProps) {
  const targetName = useParams().targetName as string;
  const loadTarget = useCallback(() => getTarget(credentials, targetName), [
    credentials,
    targetName,
  ]);
  const [targetState, reloadTarget] = useApiResource(loadTarget);

  return (
    <div className="page page-constrained">
      <Breadcrumbs items={[{ label: "Targets", path: "/targets" }, { label: targetName }]} />
      <div className="page-header">
        <div className="page-heading">
          <h1 className="prompt-title">{targetName}</h1>
          <p className="page-subtitle">
            A running Evaluation Run uses a change from its next call.
          </p>
        </div>
      </div>
      {targetState.status === "loading" && (
        <section className="panel">
          <div className="panel-loading" aria-busy="true" />
        </section>
      )}
      {targetState.status === "failed" && (
        <section className="panel">
          <LoadError
            subject="The Target"
            message={targetState.message}
            isSignInRequired={targetState.isSignInRequired}
            onRetry={reloadTarget}
            onSignInRequired={onSignInRequired}
          />
        </section>
      )}
      {targetState.status === "loaded" && (
        <TargetForm
          key={targetState.resource.updatedAt}
          credentials={credentials}
          target={targetState.resource}
          onSaved={reloadTarget}
        />
      )}
    </div>
  );
}

type CredentialChoice = "keep" | "replace" | "remove";

function TargetForm(
  { credentials, target, onSaved }: {
    credentials: ApiCredentials;
    target: Target;
    onSaved: () => void;
  },
) {
  const canEdit = useCanEditProject();
  const navigate = useNavigate();
  const [url, setUrl] = useState(target.url);
  const [description, setDescription] = useState(target.description);
  const [credentialChoice, setCredentialChoice] = useState<CredentialChoice>(
    target.credentialHeaderName === null ? "remove" : "keep",
  );
  const [credential, setCredential] = useState<CredentialDraft>({
    ...NEW_CREDENTIAL_DRAFT,
    headerName: target.credentialHeaderName ?? NEW_CREDENTIAL_DRAFT.headerName,
  });
  const [problem, setProblem] = useState<string | null>(null);
  const [isSaved, setIsSaved] = useState(false);

  const submit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    setProblem(null);
    setIsSaved(false);
    if (credentialChoice === "replace" && credential.headerValue === "") {
      setProblem("Enter the new credential value, or keep the stored one.");
      return;
    }
    try {
      await updateTarget(credentials, target.name, {
        url: url.trim(),
        description,
        ...(credentialChoice === "keep" ? {} : {
          credential: credentialChoice === "remove" ? null : {
            headerName: credential.headerName.trim(),
            headerValue: credential.headerValue,
          },
        }),
      });
      setIsSaved(true);
      onSaved();
    } catch (error) {
      setProblem((error as Error).message);
    }
  };

  const remove = async () => {
    setProblem(null);
    try {
      await deleteTarget(credentials, target.name);
      navigate("/targets");
    } catch (error) {
      setProblem((error as Error).message);
    }
  };

  return (
    <form className="form-card target-form" onSubmit={submit} noValidate>
      <div className="form-field">
        <label className="field-label" htmlFor="target-url">URL</label>
        <input
          id="target-url"
          className="text-input text-input-mono"
          autoComplete="off"
          spellCheck={false}
          disabled={!canEdit}
          value={url}
          onChange={(changeEvent) => setUrl(changeEvent.target.value)}
        />
      </div>
      <div className="form-field">
        <label className="field-label" htmlFor="target-description">Description</label>
        <textarea
          id="target-description"
          className="text-area"
          rows={2}
          disabled={!canEdit}
          value={description}
          onChange={(changeEvent) => setDescription(changeEvent.target.value)}
        />
      </div>
      <div className="form-field">
        <span className="field-label" id="target-credential-label">Credential</span>
        <p className="status-text">
          {target.credentialHeaderName === null
            ? "No credential is stored."
            : `A value for the header ${target.credentialHeaderName} is stored encrypted.`}
        </p>
        {canEdit && (
          <div
            className="segmented-control segmented-control-text"
            role="radiogroup"
            aria-labelledby="target-credential-label"
          >
            {(target.credentialHeaderName === null
              ? (["remove", "replace"] as const)
              : (["keep", "replace", "remove"] as const)).map((choice) => (
                <button
                  key={choice}
                  type="button"
                  role="radio"
                  aria-checked={credentialChoice === choice}
                  className="segmented-control-option"
                  onClick={() => setCredentialChoice(choice)}
                >
                  {{ keep: "Keep", replace: "Replace", remove: "None" }[choice]}
                </button>
              ))}
          </div>
        )}
      </div>
      {credentialChoice === "replace" && (
        <CredentialFields
          idPrefix="target"
          draft={credential}
          valuePlaceholder="Bearer …"
          onChange={setCredential}
        />
      )}
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
          <button type="button" className="button button-secondary" onClick={remove}>
            <TrashIcon size={14} />
            Delete Target
          </button>
          <button type="submit" className="button button-primary">Save Target</button>
        </div>
      )}
    </form>
  );
}
