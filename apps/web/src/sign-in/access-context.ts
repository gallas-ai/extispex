import type { AccessibleProject, User } from "@extispex/contracts";
import { createContext, useContext } from "react";
import type { ApiCredentials } from "../api/api-request.ts";

/** Who is signed in, which Projects they reach, and the Project the UI shows. */
export interface AccessContextValue {
  user: User;
  /** Every Project the user sees, by name: with a Role, or any for an Instance admin. */
  projects: AccessibleProject[];
  /** The Project whose traces and prompts the UI shows, or null without any Role. */
  selectedProject: AccessibleProject | null;
  /** Tokens for the selected Project, or for managing access without one. */
  credentials: ApiCredentials;
  selectProject(projectId: string): void;
  /** Reads the user and their Projects again, after a change to Projects or Roles. */
  reloadAccess(): Promise<void>;
  signOut(): Promise<void>;
  /** Shows the sign-in page, after a request found that the sign-in has ended. */
  showSignIn(): void;
}

export const AccessContext = createContext<AccessContextValue | null>(null);

export function useAccess(): AccessContextValue {
  const accessContext = useContext(AccessContext);
  if (accessContext === null) throw new Error("useAccess needs a signed-in AccessContext.");
  return accessContext;
}

/** Whether the user may change data in the selected Project: an `editor` or `admin` there. */
export function useCanEditProject(): boolean {
  const role = useAccess().selectedProject?.role;
  return role === "editor" || role === "admin";
}
