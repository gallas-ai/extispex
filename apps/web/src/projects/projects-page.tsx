import type { Project } from "@extispex/contracts";
import { type FormEvent, useCallback, useState } from "react";
import { Link, useNavigate } from "react-router";
import { isApiKeyRejection } from "../api/api-request.ts";
import { createProject, listProjects } from "../api/identity-api.ts";
import { formatRelativeTime } from "../traces/trace-formatting.ts";
import { AlertIcon, FolderIcon, LogOutIcon, PlusIcon } from "../ui/icons.tsx";
import { LoadError } from "../ui/load-error.tsx";
import { useApiResource } from "../ui/use-api-resource.ts";
import { useNow } from "../ui/use-now.ts";
import { InstanceAdminKeyForm } from "./instance-admin-key-form.tsx";

export interface InstanceAdminProps {
  instanceAdminKey: string;
  onInstanceAdminKeyChange: (instanceAdminKey: string) => void;
}

export const REJECTED_ADMIN_KEY_PROBLEM = "The Instance admin key was not accepted.";

export function projectPagePath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}`;
}

/** Lists the Instance's Projects and creates new ones, with the Instance admin key. */
export function ProjectsPage({ instanceAdminKey, onInstanceAdminKeyChange }: InstanceAdminProps) {
  return (
    <div className="page page-constrained projects-page">
      <div className="page-header">
        <div className="page-heading">
          <h1>Projects</h1>
          <p className="page-subtitle">
            Each Project keeps its telemetry and prompts apart, and its API keys decide where data
            goes.
          </p>
        </div>
        {instanceAdminKey !== "" && (
          <div className="page-actions">
            <button
              type="button"
              className="button button-ghost"
              onClick={() => onInstanceAdminKeyChange("")}
            >
              <LogOutIcon size={14} />
              Forget admin key
            </button>
          </div>
        )}
      </div>
      {instanceAdminKey === ""
        ? <InstanceAdminKeyForm onSubmit={onInstanceAdminKeyChange} problem={null} />
        : (
          <ProjectList
            instanceAdminKey={instanceAdminKey}
            onInstanceAdminKeyChange={onInstanceAdminKeyChange}
          />
        )}
    </div>
  );
}

function ProjectList({ instanceAdminKey, onInstanceAdminKeyChange }: InstanceAdminProps) {
  const loadProjects = useCallback(() => listProjects(instanceAdminKey), [instanceAdminKey]);
  const [projectsState, reloadProjects] = useApiResource(loadProjects);

  if (projectsState.status === "failed" && projectsState.isApiKeyRejected) {
    return (
      <InstanceAdminKeyForm
        onSubmit={onInstanceAdminKeyChange}
        problem={REJECTED_ADMIN_KEY_PROBLEM}
      />
    );
  }
  return (
    <>
      <NewProjectForm
        instanceAdminKey={instanceAdminKey}
        onInstanceAdminKeyChange={onInstanceAdminKeyChange}
      />
      <section className="panel project-list-panel" aria-label="Project list">
        {projectsState.status === "loading" && <div className="panel-loading" />}
        {projectsState.status === "failed" && (
          <LoadError
            subject="Projects"
            message={projectsState.message}
            isApiKeyRejected={false}
            onRetry={reloadProjects}
            onDisconnect={() => onInstanceAdminKeyChange("")}
          />
        )}
        {projectsState.status === "loaded" && projectsState.resource.projects.length === 0 && (
          <div className="empty-state">
            <span className="empty-state-icon">
              <FolderIcon size={22} />
            </span>
            <h2>No Projects yet</h2>
            <p>Create a Project above, then an API key for your application to send data with.</p>
          </div>
        )}
        {projectsState.status === "loaded" && projectsState.resource.projects.length > 0 && (
          <ProjectTable projects={projectsState.resource.projects} />
        )}
      </section>
    </>
  );
}

function NewProjectForm({ instanceAdminKey, onInstanceAdminKeyChange }: InstanceAdminProps) {
  const navigate = useNavigate();
  const [projectName, setProjectName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    if (projectName.trim() === "") {
      setProblem("Give the Project a name.");
      return;
    }
    setIsCreating(true);
    setProblem(null);
    try {
      const project = await createProject(instanceAdminKey, projectName.trim());
      navigate(projectPagePath(project.id));
    } catch (error) {
      if (isApiKeyRejection(error)) {
        onInstanceAdminKeyChange("");
        return;
      }
      setProblem((error as Error).message);
      setIsCreating(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="new-project-title">
      <h2 id="new-project-title" className="panel-title">New Project</h2>
      <form className="panel-form" onSubmit={submit}>
        <label htmlFor="project-name-input" className="field-label">Project name</label>
        <div className="inline-form">
          <input
            id="project-name-input"
            className="text-input"
            autoComplete="off"
            maxLength={64}
            placeholder="checkout-assistant"
            value={projectName}
            onChange={(changeEvent) => setProjectName(changeEvent.target.value)}
          />
          <button type="submit" className="button button-primary" disabled={isCreating}>
            <PlusIcon size={14} />
            {isCreating ? "Creating…" : "Create Project"}
          </button>
        </div>
        {problem !== null && (
          <p className="form-problem" role="alert">
            <AlertIcon size={14} />
            {problem}
          </p>
        )}
      </form>
    </section>
  );
}

function ProjectTable({ projects }: { projects: Project[] }) {
  const navigate = useNavigate();
  const nowUnixMilliseconds = useNow(15_000);
  return (
    <div className="table-scroll">
      <table className="data-table project-table">
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col" className="column-numeric">Created</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <tr
              key={project.id}
              className="clickable-row"
              onClick={(clickEvent) => {
                // The name is a real link; a click anywhere else on the row does the same.
                if ((clickEvent.target as HTMLElement).closest("a") === null) {
                  navigate(projectPagePath(project.id));
                }
              }}
            >
              <td>
                <Link className="project-cell-name" to={projectPagePath(project.id)}>
                  {project.name}
                </Link>
              </td>
              <td
                className="column-numeric text-muted"
                title={new Date(project.createdAt).toLocaleString()}
              >
                {formatRelativeTime(Date.parse(project.createdAt), nowUnixMilliseconds)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
