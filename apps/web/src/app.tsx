import type { AccessibleProject, User } from "@extispex/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation } from "react-router";
import { AccessPage } from "./access/access-page.tsx";
import { isSignInRequired } from "./api/api-request.ts";
import { DatasetPage } from "./datasets/dataset-page.tsx";
import { DatasetsPage } from "./datasets/datasets-page.tsx";
import { EditTestCasePage, NewTestCasePage } from "./datasets/test-case-editor-page.tsx";
import { EvaluationRunPage } from "./evaluation-runs/evaluation-run-page.tsx";
import { EvaluationRunsPage } from "./evaluation-runs/evaluation-runs-page.tsx";
import { getCurrentUser, listProjects } from "./api/identity-api.ts";
import { signOut } from "./api/sign-in-api.ts";
import { ProjectPage } from "./projects/project-page.tsx";
import { ProjectSwitcher } from "./projects/project-switcher.tsx";
import { ProjectsPage } from "./projects/projects-page.tsx";
import { PromptComparisonPage } from "./prompts/prompt-comparison-page.tsx";
import { NewPromptPage, NewPromptVersionPage } from "./prompts/prompt-editor-page.tsx";
import { PromptPage } from "./prompts/prompt-page.tsx";
import { NEW_PROMPT_PATH, PromptsPage } from "./prompts/prompts-page.tsx";
import { AccessContext, type AccessContextValue, useAccess } from "./sign-in/access-context.ts";
import { createAccessTokenCredentials } from "./sign-in/access-token-credentials.ts";
import { readStoredProjectId, storeProjectId } from "./sign-in/selected-project-storage.ts";
import { SignInPage } from "./sign-in/sign-in-page.tsx";
import { UserMenu } from "./sign-in/user-menu.tsx";
import { ThemeSwitcher } from "./theme/theme-switcher.tsx";
import { TracesPage } from "./traces/traces-page.tsx";
import {
  ActivityIcon,
  AlertIcon,
  BrandMark,
  DatasetIcon,
  FolderIcon,
  InboxIcon,
  PromptIcon,
  RunIcon,
  ShieldIcon,
} from "./ui/icons.tsx";

export function App() {
  return (
    // Without transitions, a URL change is applied before the next key press is handled, so
    // keyboard selection such as `j`, `k` and the arrow keys always starts from the current state.
    <BrowserRouter useTransitions={false}>
      <SignInGate />
    </BrowserRouter>
  );
}

type SignInState =
  | { status: "checking" }
  | { status: "signed-out"; notice: string | null }
  | { status: "failed"; message: string }
  | { status: "signed-in"; user: User; projects: AccessibleProject[] };

const ENDED_SIGN_IN_NOTICE = "Your sign-in has ended. Sign in again to continue.";

/**
 * Shows the sign-in page until the browser is signed in, then the app with the user's Projects.
 * Whether the browser is signed in shows only by asking for a token: the cookie is HttpOnly.
 */
function SignInGate() {
  const [signInState, setSignInState] = useState<SignInState>({ status: "checking" });
  const [selectedProjectId, setSelectedProjectId] = useState(readStoredProjectId);
  const hasSignedInRef = useRef(false);

  const showSignIn = useCallback(() => {
    setSignInState({
      status: "signed-out",
      notice: hasSignedInRef.current ? ENDED_SIGN_IN_NOTICE : null,
    });
  }, []);

  // Tokens without a Project read the user and their Projects.
  const accessCredentials = useMemo(
    () => createAccessTokenCredentials(null, showSignIn),
    [showSignIn],
  );

  const loadAccess = useCallback(async () => {
    try {
      const [user, { projects }] = await Promise.all([
        getCurrentUser(accessCredentials),
        listProjects(accessCredentials),
      ]);
      hasSignedInRef.current = true;
      setSignInState({ status: "signed-in", user, projects });
    } catch (error) {
      if (isSignInRequired(error)) {
        showSignIn();
      } else {
        setSignInState({ status: "failed", message: (error as Error).message });
      }
    }
  }, [accessCredentials, showSignIn]);

  useEffect(() => {
    loadAccess();
  }, [loadAccess]);

  const projects = signInState.status === "signed-in" ? signInState.projects : [];
  const projectsWithRole = projects.filter((project) => project.role !== null);
  const selectedProject = projectsWithRole.find((project) => project.id === selectedProjectId) ??
    projectsWithRole[0] ?? null;

  const projectCredentials = useMemo(
    () => createAccessTokenCredentials(selectedProject?.id ?? null, showSignIn),
    // A new Role in the same Project needs a new token too.
    [selectedProject?.id, selectedProject?.role, showSignIn],
  );

  if (signInState.status === "checking") return <div className="app-loading" />;
  if (signInState.status === "failed") {
    return (
      <div className="connect-page">
        <div className="empty-state empty-state-error" role="alert">
          <span className="empty-state-icon">
            <AlertIcon size={22} />
          </span>
          <h1 className="empty-state-title">Extispex could not be reached</h1>
          <p>{signInState.message}</p>
          <button type="button" className="button button-primary" onClick={loadAccess}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (signInState.status === "signed-out") {
    return <SignInPage notice={signInState.notice} onSignedIn={loadAccess} />;
  }

  const accessContext: AccessContextValue = {
    user: signInState.user,
    projects,
    selectedProject,
    credentials: projectCredentials,
    selectProject: (projectId) => {
      setSelectedProjectId(projectId);
      storeProjectId(projectId);
    },
    reloadAccess: loadAccess,
    signOut: async () => {
      await signOut();
      hasSignedInRef.current = false;
      setSignInState({ status: "signed-out", notice: null });
    },
    showSignIn,
  };
  return (
    <AccessContext.Provider value={accessContext}>
      <AppShell />
    </AccessContext.Provider>
  );
}

function AppShell() {
  const { user, selectedProject, credentials, showSignIn } = useAccess();
  const { pathname } = useLocation();
  // Creating a prompt lives outside /prompts/ so that a prompt may be named "new".
  const isInPrompts = pathname.startsWith("/prompts") || pathname === NEW_PROMPT_PATH;
  const pageProps = { credentials, onSignInRequired: showSignIn };
  const hasProject = selectedProject !== null;

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="top-bar-start">
          <Link className="brand" to="/" aria-label="Extispex home">
            <BrandMark size={26} />
            <span className="brand-name">Extispex</span>
          </Link>
          <nav className="primary-navigation" aria-label="Sections">
            {hasProject && (
              <>
                <NavLink className="navigation-link" to="/traces">
                  <ActivityIcon size={15} />
                  <span className="navigation-link-text">Traces</span>
                </NavLink>
                <Link
                  className="navigation-link"
                  to="/prompts"
                  aria-current={isInPrompts ? "page" : undefined}
                >
                  <PromptIcon size={15} />
                  <span className="navigation-link-text">Prompts</span>
                </Link>
                <NavLink className="navigation-link" to="/datasets">
                  <DatasetIcon size={15} />
                  <span className="navigation-link-text">Datasets</span>
                </NavLink>
                <NavLink className="navigation-link" to="/evaluation-runs">
                  <RunIcon size={15} />
                  <span className="navigation-link-text">Runs</span>
                </NavLink>
              </>
            )}
            <NavLink className="navigation-link" to="/projects">
              <FolderIcon size={15} />
              <span className="navigation-link-text">Projects</span>
            </NavLink>
            {user.isInstanceAdmin && (
              <NavLink className="navigation-link" to="/access">
                <ShieldIcon size={15} />
                <span className="navigation-link-text">Access</span>
              </NavLink>
            )}
          </nav>
        </div>
        <div className="top-bar-end">
          <ProjectSwitcher />
          {/* On a phone the theme moves into the account menu, to keep the bar on one line. */}
          <div className="top-bar-theme">
            <ThemeSwitcher />
          </div>
          <UserMenu />
        </div>
      </header>
      <main className="app-content">
        <Routes>
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:projectId" element={<ProjectPage />} />
          {user.isInstanceAdmin && <Route path="/access" element={<AccessPage />} />}
          {hasProject
            ? (
              <>
                <Route path="/" element={<RedirectToTraces />} />
                {/* Keyed by Project, so that switching Projects starts each page afresh. */}
                <Route
                  path="/traces"
                  element={<TracesPage key={selectedProject.id} {...pageProps} />}
                />
                <Route
                  path="/prompts"
                  element={<PromptsPage key={selectedProject.id} {...pageProps} />}
                />
                <Route path={NEW_PROMPT_PATH} element={<NewPromptPage {...pageProps} />} />
                <Route
                  path="/prompts/:promptName"
                  element={<PromptPage key={selectedProject.id} {...pageProps} />}
                />
                <Route
                  path="/prompts/:promptName/versions/new"
                  element={<NewPromptVersionPage {...pageProps} />}
                />
                <Route
                  path="/prompts/:promptName/compare"
                  element={<PromptComparisonPage key={selectedProject.id} {...pageProps} />}
                />
                <Route
                  path="/datasets"
                  element={<DatasetsPage key={selectedProject.id} {...pageProps} />}
                />
                <Route
                  path="/datasets/:datasetName"
                  element={<DatasetPage key={selectedProject.id} {...pageProps} />}
                />
                <Route
                  path="/datasets/:datasetName/new-test-case"
                  element={<NewTestCasePage {...pageProps} />}
                />
                <Route
                  path="/datasets/:datasetName/test-cases/:testCaseName"
                  element={<EditTestCasePage key={selectedProject.id} {...pageProps} />}
                />
                <Route
                  path="/evaluation-runs"
                  element={<EvaluationRunsPage key={selectedProject.id} {...pageProps} />}
                />
                <Route
                  path="/evaluation-runs/:runId"
                  element={<EvaluationRunPage key={selectedProject.id} {...pageProps} />}
                />
                <Route path="*" element={<PageNotFound />} />
              </>
            )
            : <Route path="*" element={<NoProject />} />}
        </Routes>
      </main>
    </div>
  );
}

/** Keeps links to the first version of the UI, which showed traces at `/?sessionId=…`, working. */
function RedirectToTraces() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: "/traces", search }} replace />;
}

/** Shown while the user has no Role in any Project. */
function NoProject() {
  const { user } = useAccess();
  return (
    <div className="page">
      <div className="empty-state">
        <span className="empty-state-icon">
          <FolderIcon size={22} />
        </span>
        <h1 className="empty-state-title">You have no Role in a Project yet</h1>
        <p>
          {user.isInstanceAdmin
            ? "Give one of your Groups a Role in a Project to see its traces and prompts."
            : "Ask an admin to add you to a Group with a Role in a Project."}
        </p>
        <Link className="button button-secondary" to="/projects">Go to Projects</Link>
      </div>
    </div>
  );
}

function PageNotFound() {
  return (
    <div className="page">
      <div className="empty-state">
        <span className="empty-state-icon">
          <InboxIcon size={22} />
        </span>
        <h1 className="empty-state-title">This page does not exist</h1>
        <p>The link may be outdated.</p>
        <Link className="button button-secondary" to="/traces">Go to Traces</Link>
      </div>
    </div>
  );
}
