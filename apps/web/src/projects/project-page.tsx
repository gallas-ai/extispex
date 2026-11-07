import type { ApiKey, CreatedApiKey, Project } from "@extispex/contracts";
import { type FormEvent, useCallback, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { isApiKeyRejection } from "../api/api-request.ts";
import {
  createApiKey,
  deleteProject,
  getProject,
  listApiKeys,
  revokeApiKey,
} from "../api/identity-api.ts";
import { formatRelativeTime } from "../traces/trace-formatting.ts";
import { CopyButton } from "../ui/copy-button.tsx";
import { AlertIcon, CheckIcon, FolderIcon, KeyIcon, PlusIcon, TrashIcon } from "../ui/icons.tsx";
import { LoadError } from "../ui/load-error.tsx";
import { useApiResource } from "../ui/use-api-resource.ts";
import { useNow } from "../ui/use-now.ts";
import { InstanceAdminKeyForm } from "./instance-admin-key-form.tsx";
import { type InstanceAdminProps, REJECTED_ADMIN_KEY_PROBLEM } from "./projects-page.tsx";

interface ProjectPageProps extends InstanceAdminProps {
  /** Makes the browser use a new key for Traces and Prompts. */
  onUseApiKey: (apiKey: string) => void;
}

interface ProjectWithApiKeys {
  project: Project;
  apiKeys: ApiKey[];
}

/** One Project: creating and revoking its API keys, and deleting it. */
export function ProjectPage(
  { instanceAdminKey, onInstanceAdminKeyChange, onUseApiKey }: ProjectPageProps,
) {
  const { projectId = "" } = useParams();
  const loadProject = useCallback(async (): Promise<ProjectWithApiKeys> => {
    const [project, { apiKeys }] = await Promise.all([
      getProject(instanceAdminKey, projectId),
      listApiKeys(instanceAdminKey, projectId),
    ]);
    return { project, apiKeys };
  }, [instanceAdminKey, projectId]);
  const [projectState, reloadProject] = useApiResource(loadProject);
  const forgetRejectedKey = () => onInstanceAdminKeyChange("");

  const breadcrumbs = (
    <nav className="breadcrumbs" aria-label="Breadcrumbs">
      <ol>
        <li>
          <Link to="/projects">Projects</Link>
        </li>
        {projectState.status === "loaded" && <li>{projectState.resource.project.name}</li>}
      </ol>
    </nav>
  );

  if (instanceAdminKey === "") {
    return (
      <div className="page page-constrained projects-page">
        {breadcrumbs}
        <InstanceAdminKeyForm onSubmit={onInstanceAdminKeyChange} problem={null} />
      </div>
    );
  }
  if (projectState.status === "failed" && projectState.isApiKeyRejected) {
    return (
      <div className="page page-constrained projects-page">
        {breadcrumbs}
        <InstanceAdminKeyForm
          onSubmit={onInstanceAdminKeyChange}
          problem={REJECTED_ADMIN_KEY_PROBLEM}
        />
      </div>
    );
  }
  if (projectState.status === "failed" && projectState.statusCode === 404) {
    return (
      <div className="page page-constrained projects-page">
        {breadcrumbs}
        <div className="empty-state">
          <span className="empty-state-icon">
            <FolderIcon size={22} />
          </span>
          <h1 className="empty-state-title">This Project does not exist</h1>
          <p>It may have been deleted.</p>
          <Link className="button button-secondary" to="/projects">Go to Projects</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page page-constrained projects-page">
      {breadcrumbs}
      {projectState.status === "loading" && <div className="panel panel-loading" />}
      {projectState.status === "failed" && (
        <section className="panel">
          <LoadError
            subject="The Project"
            message={projectState.message}
            isApiKeyRejected={false}
            onRetry={reloadProject}
            onDisconnect={forgetRejectedKey}
          />
        </section>
      )}
      {projectState.status === "loaded" && (
        <>
          <div className="page-header">
            <div className="page-heading">
              <h1 className="project-title">{projectState.resource.project.name}</h1>
              <p className="page-subtitle">
                Project ID <code>{projectState.resource.project.id}</code>
              </p>
            </div>
          </div>
          <ApiKeysPanel
            instanceAdminKey={instanceAdminKey}
            project={projectState.resource.project}
            apiKeys={projectState.resource.apiKeys}
            onChange={reloadProject}
            onKeyRejected={forgetRejectedKey}
            onUseApiKey={onUseApiKey}
          />
          <DeleteProjectPanel
            instanceAdminKey={instanceAdminKey}
            project={projectState.resource.project}
            onKeyRejected={forgetRejectedKey}
          />
        </>
      )}
    </div>
  );
}

interface ApiKeysPanelProps {
  instanceAdminKey: string;
  project: Project;
  apiKeys: ApiKey[];
  onChange: () => void;
  onKeyRejected: () => void;
  onUseApiKey: (apiKey: string) => void;
}

function ApiKeysPanel(
  { instanceAdminKey, project, apiKeys, onChange, onKeyRejected, onUseApiKey }: ApiKeysPanelProps,
) {
  const navigate = useNavigate();
  const [keyName, setKeyName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);

  const reportFailure = (error: unknown) => {
    if (isApiKeyRejection(error)) {
      onKeyRejected();
    } else {
      setProblem((error as Error).message);
    }
  };

  const submit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    if (keyName.trim() === "") {
      setProblem("Name the key after where it is used, such as CI pipeline.");
      return;
    }
    setIsCreating(true);
    setProblem(null);
    try {
      setCreatedKey(await createApiKey(instanceAdminKey, project.id, keyName.trim()));
      setKeyName("");
      onChange();
    } catch (error) {
      reportFailure(error);
    } finally {
      setIsCreating(false);
    }
  };

  const revoke = async (apiKey: ApiKey) => {
    setProblem(null);
    try {
      await revokeApiKey(instanceAdminKey, project.id, apiKey.id);
      if (createdKey?.id === apiKey.id) setCreatedKey(null);
      onChange();
    } catch (error) {
      reportFailure(error);
    }
  };

  return (
    <section className="panel api-keys-panel" aria-labelledby="api-keys-title">
      <h2 id="api-keys-title" className="panel-title">API keys</h2>
      <form className="panel-form" onSubmit={submit}>
        <label htmlFor="api-key-name-input" className="field-label">New key's name</label>
        <div className="inline-form">
          <input
            id="api-key-name-input"
            className="text-input"
            autoComplete="off"
            maxLength={64}
            placeholder="CI pipeline"
            value={keyName}
            onChange={(changeEvent) => setKeyName(changeEvent.target.value)}
          />
          <button type="submit" className="button button-primary" disabled={isCreating}>
            <PlusIcon size={14} />
            {isCreating ? "Creating…" : "Create API key"}
          </button>
        </div>
        <p className="field-hint">
          Applications send the key as{" "}
          <code>Authorization: Bearer &lt;key&gt;</code>, for OTLP and the REST API alike.
        </p>
        {problem !== null && (
          <p className="form-problem" role="alert">
            <AlertIcon size={14} />
            {problem}
          </p>
        )}
      </form>

      {createdKey !== null && (
        <div className="new-api-key" role="status" aria-label="New API key">
          <p className="new-api-key-title">
            <CheckIcon size={15} />
            Copy the key for {createdKey.name} now. It is shown only once.
          </p>
          <div className="new-api-key-value">
            <code className="new-api-key-secret">{createdKey.apiKey}</code>
            <CopyButton value={createdKey.apiKey} label="API key" />
          </div>
          <div className="new-api-key-actions">
            <button
              type="button"
              className="button button-secondary button-small"
              onClick={() => {
                onUseApiKey(createdKey.apiKey);
                navigate("/traces");
              }}
            >
              <KeyIcon size={13} />
              Use in this browser
            </button>
            <button
              type="button"
              className="button button-ghost button-small"
              onClick={() => setCreatedKey(null)}
            >
              Done
            </button>
          </div>
        </div>
      )}

      {apiKeys.length === 0
        ? <p className="panel-empty-text">This Project has no API keys yet.</p>
        : <ApiKeyTable apiKeys={apiKeys} onRevoke={revoke} />}
    </section>
  );
}

function ApiKeyTable(
  { apiKeys, onRevoke }: { apiKeys: ApiKey[]; onRevoke: (apiKey: ApiKey) => Promise<void> },
) {
  const nowUnixMilliseconds = useNow(15_000);
  const [confirmingKeyId, setConfirmingKeyId] = useState<string | null>(null);
  return (
    <div className="table-scroll">
      <table className="data-table api-key-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col" className="column-key">Key</th>
            <th scope="col" className="column-numeric column-created">Created</th>
            <th scope="col" className="column-actions">
              <span className="visually-hidden">Status</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {apiKeys.map((apiKey) => (
            <tr
              key={apiKey.id}
              className={apiKey.revokedAt === null ? "api-key-row" : "api-key-row api-key-revoked"}
            >
              <td className="api-key-name">{apiKey.name}</td>
              <td className="column-key">
                <code className="api-key-prefix">{apiKey.keyPrefix}…</code>
              </td>
              <td
                className="column-numeric column-created text-muted"
                title={new Date(apiKey.createdAt).toLocaleString()}
              >
                {formatRelativeTime(Date.parse(apiKey.createdAt), nowUnixMilliseconds)}
              </td>
              <td className="column-actions">
                {apiKey.revokedAt !== null && (
                  <span
                    className="status-text"
                    title={`Revoked ${new Date(apiKey.revokedAt).toLocaleString()}`}
                  >
                    Revoked
                  </span>
                )}
                {apiKey.revokedAt === null && confirmingKeyId !== apiKey.id && (
                  <button
                    type="button"
                    className="button button-ghost button-danger button-small"
                    onClick={() => setConfirmingKeyId(apiKey.id)}
                    aria-label={`Revoke ${apiKey.name}`}
                  >
                    Revoke
                  </button>
                )}
                {apiKey.revokedAt === null && confirmingKeyId === apiKey.id && (
                  <span className="confirm-actions">
                    <button
                      type="button"
                      className="button button-ghost button-small"
                      onClick={() => setConfirmingKeyId(null)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="button button-danger-solid button-small"
                      autoFocus
                      onClick={async () => {
                        await onRevoke(apiKey);
                        setConfirmingKeyId(null);
                      }}
                    >
                      Confirm revoke
                    </button>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface DeleteProjectPanelProps {
  instanceAdminKey: string;
  project: Project;
  onKeyRejected: () => void;
}

function DeleteProjectPanel({ instanceAdminKey, project, onKeyRejected }: DeleteProjectPanelProps) {
  const navigate = useNavigate();
  const [isConfirming, setIsConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const remove = async () => {
    setProblem(null);
    try {
      await deleteProject(instanceAdminKey, project.id);
      navigate("/projects");
    } catch (error) {
      if (isApiKeyRejection(error)) {
        onKeyRejected();
      } else {
        setProblem((error as Error).message);
      }
    }
  };

  return (
    <section className="panel danger-panel" aria-labelledby="delete-project-title">
      <h2 id="delete-project-title" className="panel-title">Delete Project</h2>
      <div className="panel-form">
        <p className="danger-panel-text">
          Its API keys stop working within a minute, and its telemetry and prompts become
          unreachable. This cannot be undone.
        </p>
        {problem !== null && (
          <p className="form-problem" role="alert">
            <AlertIcon size={14} />
            {problem}
          </p>
        )}
        <div className="confirm-actions">
          {isConfirming
            ? (
              <>
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => setIsConfirming(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="button button-danger-solid"
                  autoFocus
                  onClick={remove}
                >
                  <TrashIcon size={14} />
                  Delete {project.name}
                </button>
              </>
            )
            : (
              <button
                type="button"
                className="button button-secondary button-danger"
                onClick={() => setIsConfirming(true)}
              >
                <TrashIcon size={14} />
                Delete Project
              </button>
            )}
        </div>
      </div>
    </section>
  );
}
