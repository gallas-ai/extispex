import type { AccessibleProject, DeletedProject, ProjectDataRemoval } from "@extispex/contracts";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { createProject, listDeletedProjects } from "../api/identity-api.ts";
import { useAccess } from "../sign-in/access-context.ts";
import { formatRelativeTime } from "../traces/trace-formatting.ts";
import { AlertIcon, FolderIcon, PlusIcon } from "../ui/icons.tsx";
import { LoadError } from "../ui/load-error.tsx";
import { useApiResource } from "../ui/use-api-resource.ts";
import { useNow } from "../ui/use-now.ts";
import { usePollingWhile } from "../ui/use-polling-while.ts";

export function projectPagePath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}`;
}

/** The Projects the user has a Role in, or every Project for an Instance admin, who creates them. */
export function ProjectsPage() {
  const { user, projects, reloadAccess } = useAccess();

  useEffect(() => {
    // Another admin may have added the user to a Project since the app loaded.
    reloadAccess();
  }, [reloadAccess]);

  return (
    <div className="page page-constrained projects-page">
      <div className="page-header">
        <div className="page-heading">
          <h1>Projects</h1>
          <p className="page-subtitle">
            Each Project keeps its telemetry and prompts apart. Groups get a Role in each Project.
          </p>
        </div>
      </div>
      {user.isInstanceAdmin && <NewProjectForm />}
      <section className="panel project-list-panel" aria-label="Project list">
        {projects.length === 0
          ? (
            <div className="empty-state">
              <span className="empty-state-icon">
                <FolderIcon size={22} />
              </span>
              <h2>No Projects yet</h2>
              <p>
                {user.isInstanceAdmin
                  ? "Create a Project above, then give a Group a Role in it."
                  : "You have no Role in a Project. Ask an admin to add you to a Group."}
              </p>
            </div>
          )
          : <ProjectTable projects={projects} />}
      </section>
      {user.isInstanceAdmin && <DeletedProjectsPanel />}
    </div>
  );
}

function NewProjectForm() {
  const navigate = useNavigate();
  const { credentials, reloadAccess } = useAccess();
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
      const project = await createProject(credentials, projectName.trim());
      await reloadAccess();
      navigate(projectPagePath(project.id));
    } catch (error) {
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

function ProjectTable({ projects }: { projects: AccessibleProject[] }) {
  const navigate = useNavigate();
  const nowUnixMilliseconds = useNow(15_000);
  return (
    <div className="table-scroll">
      <table className="data-table project-table">
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col">Your Role</th>
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
              <td>
                {project.role === null
                  ? <span className="status-text">None</span>
                  : <span className="role-badge">{project.role}</span>}
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

const SERVICE_LABELS: Record<ProjectDataRemoval["service"], string> = {
  identity: "Identity",
  telemetry: "Telemetry",
  prompt: "Prompt",
  evaluation: "Evaluation",
};

function describeDataRemoval(removal: ProjectDataRemoval): string {
  if (removal.isComplete) return "Removed";
  return removal.removedAt === null ? "Waiting" : "Removing";
}

/**
 * Deleted Projects and how far each service has got with removing their data. A service keeps
 * removing until no access token issued before the deletion can write any more.
 */
function DeletedProjectsPanel() {
  const { credentials, showSignIn } = useAccess();
  const loadDeletedProjects = useCallback(
    async () => (await listDeletedProjects(credentials)).deletedProjects,
    [credentials],
  );
  const [deletedProjectsState, reloadDeletedProjects] = useApiResource(loadDeletedProjects);
  usePollingWhile(
    deletedProjectsState.status === "loaded" &&
      deletedProjectsState.resource.some((deletedProject) =>
        deletedProject.dataRemovals.some((removal) => !removal.isComplete)
      ),
    reloadDeletedProjects,
  );
  if (deletedProjectsState.status === "loaded" && deletedProjectsState.resource.length === 0) {
    return null;
  }
  return (
    <section className="panel deleted-projects-panel" aria-labelledby="deleted-projects-title">
      <h2 id="deleted-projects-title" className="panel-title">Deleted Projects</h2>
      <p className="panel-form field-hint">
        Each service removes a deleted Project's data within minutes. It is gone for good once every
        service shows Removed.
      </p>
      {deletedProjectsState.status === "loading" && (
        <div className="panel-loading" aria-busy="true" />
      )}
      {deletedProjectsState.status === "failed" && (
        <LoadError
          subject="Deleted Projects"
          message={deletedProjectsState.message}
          isSignInRequired={deletedProjectsState.isSignInRequired}
          onRetry={reloadDeletedProjects}
          onSignInRequired={showSignIn}
        />
      )}
      {deletedProjectsState.status === "loaded" && (
        <ul className="deleted-project-list">
          {deletedProjectsState.resource.map((deletedProject) => (
            <DeletedProjectRow key={deletedProject.id} deletedProject={deletedProject} />
          ))}
        </ul>
      )}
    </section>
  );
}

function DeletedProjectRow({ deletedProject }: { deletedProject: DeletedProject }) {
  const nowUnixMilliseconds = useNow(15_000);
  return (
    <li className="deleted-project" aria-label={`Deleted Project ${deletedProject.name}`}>
      <div className="deleted-project-heading">
        <span className="deleted-project-name">{deletedProject.name}</span>
        <span className="text-muted" title={new Date(deletedProject.deletedAt).toLocaleString()}>
          Deleted {formatRelativeTime(Date.parse(deletedProject.deletedAt), nowUnixMilliseconds)}
        </span>
      </div>
      <ul className="data-removal-list" aria-label="Data removal by service">
        {deletedProject.dataRemovals.map((removal) => (
          <li
            key={removal.service}
            className={removal.isComplete ? "data-removal data-removal-complete" : "data-removal"}
            title={removal.removedAt === null
              ? undefined
              : `Last removed ${new Date(removal.removedAt).toLocaleString()}`}
          >
            <span className="data-removal-service">{SERVICE_LABELS[removal.service]}</span>
            {describeDataRemoval(removal)}
          </li>
        ))}
      </ul>
    </li>
  );
}
