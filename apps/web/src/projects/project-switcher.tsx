import { Link } from "react-router";
import { useAccess } from "../sign-in/access-context.ts";
import { CheckIcon, ChevronRightIcon, FolderIcon } from "../ui/icons.tsx";
import { usePopover } from "../ui/use-popover.ts";

/** Chooses the Project whose traces and prompts the UI shows, among those with a Role. */
export function ProjectSwitcher() {
  const { projects, selectedProject, selectProject } = useAccess();
  const { isOpen, setIsOpen, anchorRef } = usePopover();
  const projectsWithRole = projects.filter((project) => project.role !== null);
  if (selectedProject === null) return null;

  return (
    <div className="popover-anchor project-switcher" ref={anchorRef}>
      <button
        type="button"
        className="button button-ghost project-switcher-trigger"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={`Project ${selectedProject.name}, change Project`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <FolderIcon size={14} />
        <span className="project-switcher-name">{selectedProject.name}</span>
        <span className="role-badge">{selectedProject.role}</span>
      </button>
      {isOpen && (
        <div className="popover project-switcher-popover" role="dialog" aria-label="Projects">
          <div className="popover-section">
            <p className="popover-title">Project</p>
            <ul className="project-switcher-list">
              {projectsWithRole.map((project) => (
                <li key={project.id}>
                  <button
                    type="button"
                    className="project-switcher-option"
                    aria-current={project.id === selectedProject.id ? "true" : undefined}
                    onClick={() => {
                      selectProject(project.id);
                      setIsOpen(false);
                    }}
                  >
                    <span className="project-switcher-check">
                      {project.id === selectedProject.id && <CheckIcon size={13} />}
                    </span>
                    <span className="project-switcher-option-name">{project.name}</span>
                    <span className="role-badge">{project.role}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="popover-section">
            <Link
              className="button button-ghost button-block-start"
              to="/projects"
              onClick={() =>
                setIsOpen(false)}
            >
              <ChevronRightIcon size={14} />
              All Projects
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
