import type { Role } from "@extispex/contracts";

/**
 * Kept in step with `packages/contracts`, from which the UI imports only types, so that zod does
 * not reach the browser bundle (ADR 0006). The API checks both rules again.
 */
export const ROLES = ["viewer", "editor", "admin"] as const satisfies readonly Role[];
export const MINIMUM_PASSWORD_LENGTH = 12;
