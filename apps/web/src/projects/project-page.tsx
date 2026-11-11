import type {
  AccessibleProject,
  ApiKey,
  CreatedApiKey,
  Group,
  Role,
  RoleAssignment,
} from "@extispex/contracts";
import { type FormEvent, useCallback, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  assignRole,
  createApiKey,
  deleteProject,
  getProject,
  listApiKeys,
  listGroups,
  listRoleAssignments,
  removeRoleAssignment,
  revokeApiKey,
  updateProject,
} from "../api/identity-api.ts";
import { MAXIMUM_RETENTION_DAYS, MINIMUM_RETENTION_DAYS, ROLES } from "../access/access-rules.ts";
import { useAccess } from "../sign-in/access-context.ts";
import { formatRelativeTime } from "../traces/trace-formatting.ts";
import { CopyButton } from "../ui/copy-button.tsx";
import { AlertIcon, CheckIcon, FolderIcon, PlusIcon, TrashIcon } from "../ui/icons.tsx";
import { LoadError } from "../ui/load-error.tsx";
import { useApiResource } from "../ui/use-api-resource.ts";
import { useNow } from "../ui/use-now.ts";

/** What each Role allows, as the Role assignment form explains it. */
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  viewer: "reads traces and prompts",
  editor: "also changes prompts and sends telemetry",
  admin: "also manages Roles and API keys",
};

interface ProjectDetails {
  project: AccessibleProject;
  /** Null when the user may not manage the Project. */
  management: {
    roleAssignments: RoleAssignment[];
    groups: Group[];
    apiKeys: ApiKey[];
  } | null;
}

/** One Project: who has which Role in it, its API keys, and deleting it. */
export function ProjectPage() {
  const { projectId = "" } = useParams();
  const { user, credentials, showSignIn } = useAccess();
  const loadProject = useCallback(async (): Promise<ProjectDetails> => {
    const project = await getProject(credentials, projectId);
    if (!user.isInstanceAdmin && project.role !== "admin") return { project, management: null };
    const [{ roleAssignments }, { groups }, { apiKeys }] = await Promise.all([
      listRoleAssignments(credentials, projectId),
      listGroups(credentials),
      listApiKeys(credentials, projectId),
    ]);
    return { project, management: { roleAssignments, groups, apiKeys } };
  }, [credentials, projectId, user.isInstanceAdmin]);
  const [projectState, reloadProject] = useApiResource(loadProject);

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

  if (projectState.status === "failed" && projectState.statusCode === 404) {
    return (
      <div className="page page-constrained projects-page">
        {breadcrumbs}
        <div className="empty-state">
          <span className="empty-state-icon">
            <FolderIcon size={22} />
          </span>
          <h1 className="empty-state-title">This Project does not exist</h1>
          <p>It may have been deleted, or you have no Role in it.</p>
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
            isSignInRequired={projectState.isSignInRequired}
            onRetry={reloadProject}
            onSignInRequired={showSignIn}
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
                {projectState.resource.project.role !== null && (
                  <>
                    {" · "}Your Role{" "}
                    <span className="role-badge">{projectState.resource.project.role}</span>
                  </>
                )}
              </p>
            </div>
          </div>
          <RetentionPanel
            project={projectState.resource.project}
            canChange={projectState.resource.management !== null}
            onChange={reloadProject}
          />
          {projectState.resource.management === null
            ? (
              <p className="panel panel-note">
                Only the Project's admins manage its Roles and API keys.
              </p>
            )
            : (
              <>
                <RoleAssignmentsPanel
                  projectId={projectState.resource.project.id}
                  roleAssignments={projectState.resource.management.roleAssignments}
                  groups={projectState.resource.management.groups}
                  onChange={reloadProject}
                />
                <ApiKeysPanel
                  projectId={projectState.resource.project.id}
                  apiKeys={projectState.resource.management.apiKeys}
                  onChange={reloadProject}
                />
              </>
            )}
          {user.isInstanceAdmin && <DeleteProjectPanel project={projectState.resource.project} />}
        </>
      )}
    </div>
  );
}

function RetentionPanel(
  { project, canChange, onChange }: {
    project: AccessibleProject;
    canChange: boolean;
    onChange: () => void;
  },
) {
  const { credentials, reloadAccess } = useAccess();
  const [retentionDays, setRetentionDays] = useState(String(project.retentionDays));
  const [isSaving, setIsSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    const days = Number(retentionDays);
    if (!Number.isInteger(days) || days < MINIMUM_RETENTION_DAYS || days > MAXIMUM_RETENTION_DAYS) {
      setProblem(
        `Choose a whole number of days from ${MINIMUM_RETENTION_DAYS} to ${MAXIMUM_RETENTION_DAYS}.`,
      );
      return;
    }
    setIsSaving(true);
    setProblem(null);
    try {
      await updateProject(credentials, project.id, { retentionDays: days });
      onChange();
      // Result pages read the Retention Period of the selected Project.
      await reloadAccess();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  const explanation = (
    <p className="field-hint">
      Traces, logs and metrics older than this, by their own time, are removed within ten minutes.
      Evaluation results keep their own copy and stay readable.
    </p>
  );

  return (
    <section className="panel retention-panel" aria-labelledby="retention-title">
      <h2 id="retention-title" className="panel-title">Retention</h2>
      {canChange
        ? (
          <form className="panel-form" onSubmit={submit} noValidate>
            <label htmlFor="retention-days-input" className="field-label">
              Keep telemetry for
            </label>
            <div className="inline-form retention-form">
              <span className="retention-input">
                <input
                  id="retention-days-input"
                  className="text-input"
                  type="number"
                  inputMode="numeric"
                  min={MINIMUM_RETENTION_DAYS}
                  max={MAXIMUM_RETENTION_DAYS}
                  value={retentionDays}
                  onChange={(changeEvent) => setRetentionDays(changeEvent.target.value)}
                />
                <span className="text-muted">days</span>
              </span>
              <button
                type="submit"
                className="button button-primary"
                disabled={isSaving || retentionDays === String(project.retentionDays)}
              >
                {isSaving ? "Saving…" : "Save retention"}
              </button>
            </div>
            {explanation}
            {problem !== null && (
              <p className="form-problem" role="alert">
                <AlertIcon size={14} />
                {problem}
              </p>
            )}
          </form>
        )
        : (
          <div className="panel-form">
            <p className="retention-value">
              Telemetry is kept for <strong>{project.retentionDays} days</strong>.
            </p>
            {explanation}
          </div>
        )}
    </section>
  );
}

interface RoleAssignmentsPanelProps {
  projectId: string;
  roleAssignments: RoleAssignment[];
  groups: Group[];
  onChange: () => void;
}

function RoleAssignmentsPanel(
  { projectId, roleAssignments, groups, onChange }: RoleAssignmentsPanelProps,
) {
  const { credentials, reloadAccess } = useAccess();
  const unassignedGroups = groups.filter((group) =>
    !roleAssignments.some((assignment) => assignment.groupId === group.id)
  );
  const [groupId, setGroupId] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [problem, setProblem] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const selectedGroupId = unassignedGroups.some((group) => group.id === groupId)
    ? groupId
    : unassignedGroups[0]?.id ?? "";

  const change = async (makeChange: () => Promise<unknown>) => {
    setIsSaving(true);
    setProblem(null);
    try {
      await makeChange();
      onChange();
      // The user's own Role may have changed.
      await reloadAccess();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  const submit = (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    if (selectedGroupId === "") return;
    change(() => assignRole(credentials, projectId, selectedGroupId, role));
  };

  return (
    <section className="panel role-assignments-panel" aria-labelledby="role-assignments-title">
      <h2 id="role-assignments-title" className="panel-title">Roles</h2>
      <form className="panel-form" onSubmit={submit}>
        <span className="field-label">Give a Group a Role</span>
        {unassignedGroups.length === 0
          ? (
            <p className="field-hint">
              Every Group has a Role here. Instance admins create Groups under Access.
            </p>
          )
          : (
            <div className="inline-form role-assignment-form">
              <select
                className="select-input"
                aria-label="Group"
                value={selectedGroupId}
                onChange={(changeEvent) => setGroupId(changeEvent.target.value)}
              >
                {unassignedGroups.map((group) => (
                  <option key={group.id} value={group.id}>{group.name}</option>
                ))}
              </select>
              <RoleSelect label="Role for the Group" role={role} onChange={setRole} />
              <button type="submit" className="button button-primary" disabled={isSaving}>
                <PlusIcon size={14} />
                Assign Role
              </button>
            </div>
          )}
        <p className="field-hint">
          A <code>viewer</code> {ROLE_DESCRIPTIONS.viewer}, an <code>editor</code>{" "}
          {ROLE_DESCRIPTIONS.editor}, an <code>admin</code>{" "}
          {ROLE_DESCRIPTIONS.admin}. Members' access changes within five minutes.
        </p>
        {problem !== null && (
          <p className="form-problem" role="alert">
            <AlertIcon size={14} />
            {problem}
          </p>
        )}
      </form>
      {roleAssignments.length === 0
        ? <p className="panel-empty-text">No Group has a Role in this Project yet.</p>
        : (
          <div className="table-scroll">
            <table className="data-table role-assignment-table">
              <thead>
                <tr>
                  <th scope="col">Group</th>
                  <th scope="col">Role</th>
                  <th scope="col" className="column-actions">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {roleAssignments.map((assignment) => (
                  <tr key={assignment.groupId}>
                    <td className="role-assignment-group">{assignment.groupName}</td>
                    <td>
                      <RoleSelect
                        label={`Role of ${assignment.groupName}`}
                        role={assignment.role}
                        disabled={isSaving}
                        onChange={(nextRole) =>
                          change(() =>
                            assignRole(credentials, projectId, assignment.groupId, nextRole)
                          )}
                      />
                    </td>
                    <td className="column-actions">
                      <button
                        type="button"
                        className="button button-ghost button-danger button-small"
                        disabled={isSaving}
                        aria-label={`Remove the Role of ${assignment.groupName}`}
                        onClick={() =>
                          change(() =>
                            removeRoleAssignment(credentials, projectId, assignment.groupId)
                          )}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}

function RoleSelect(
  { label, role, disabled = false, onChange }: {
    label: string;
    role: Role;
    disabled?: boolean;
    onChange: (role: Role) => void;
  },
) {
  return (
    <select
      className="select-input"
      aria-label={label}
      value={role}
      disabled={disabled}
      onChange={(changeEvent) => onChange(changeEvent.target.value as Role)}
    >
      {ROLES.map((roleOption) => <option key={roleOption} value={roleOption}>{roleOption}</option>)}
    </select>
  );
}

interface ApiKeysPanelProps {
  projectId: string;
  apiKeys: ApiKey[];
  onChange: () => void;
}

function ApiKeysPanel({ projectId, apiKeys, onChange }: ApiKeysPanelProps) {
  const { credentials } = useAccess();
  const [keyName, setKeyName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);

  const submit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    if (keyName.trim() === "") {
      setProblem("Name the key after where it is used, such as CI pipeline.");
      return;
    }
    setIsCreating(true);
    setProblem(null);
    try {
      setCreatedKey(await createApiKey(credentials, projectId, keyName.trim()));
      setKeyName("");
      onChange();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setIsCreating(false);
    }
  };

  const revoke = async (apiKey: ApiKey) => {
    setProblem(null);
    try {
      await revokeApiKey(credentials, projectId, apiKey.id);
      if (createdKey?.id === apiKey.id) setCreatedKey(null);
      onChange();
    } catch (error) {
      setProblem((error as Error).message);
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
          Applications and scripts send the key as{" "}
          <code>Authorization: Bearer &lt;key&gt;</code>, for OTLP and the REST API alike. A key
          acts as an <code>editor</code>.
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

function DeleteProjectPanel({ project }: { project: AccessibleProject }) {
  const navigate = useNavigate();
  const { credentials, reloadAccess } = useAccess();
  const [isConfirming, setIsConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const remove = async () => {
    setProblem(null);
    try {
      await deleteProject(credentials, project.id);
      await reloadAccess();
      navigate("/projects");
    } catch (error) {
      setProblem((error as Error).message);
    }
  };

  return (
    <section className="panel danger-panel" aria-labelledby="delete-project-title">
      <h2 id="delete-project-title" className="panel-title">Delete Project</h2>
      <div className="panel-form">
        <p className="danger-panel-text">
          Its API keys stop working within a minute, and every service then removes its telemetry,
          prompts, Datasets and runs for good. Projects shows how far each service is. This cannot
          be undone.
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
