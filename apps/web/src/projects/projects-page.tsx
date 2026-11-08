import type { AccessibleProject } from "@extispex/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { createProject } from "../api/identity-api.ts";
import { useAccess } from "../sign-in/access-context.ts";
import { formatRelativeTime } from "../traces/trace-formatting.ts";
import { AlertIcon, FolderIcon, PlusIcon } from "../ui/icons.tsx";
import { useNow } from "../ui/use-now.ts";

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
