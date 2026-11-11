import { z } from "zod";
import { errorResponseSchema } from "../error-response.ts";
import { companyGroupNameSchema, displayNameSchema, emailSchema } from "./access-contracts.ts";

/** How a user or a Company group reached the Instance: over SCIM or in an imported file. */
export const DIRECTORY_SOURCES = ["scim", "import"] as const;
export const directorySourceSchema = z.enum(DIRECTORY_SOURCES);

/** The most rows one imported file may have, so that one transaction stays short. */
export const MAXIMUM_DIRECTORY_IMPORT_ROWS = 5_000;

/** Lets the company's directory call the SCIM endpoints. Stored as a hash. */
export const directoryTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The token's first characters, to tell tokens apart. */
  tokenPrefix: z.string(),
  createdAt: z.string(),
  /** When the directory last used the token, to the minute, or null if it never has. */
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});

export const createDirectoryTokenRequestSchema = z.object({
  name: z.string().trim().min(1).max(64),
});

/** The token itself appears only in the response that creates it. */
export const createdDirectoryTokenSchema = directoryTokenSchema.extend({ token: z.string() });

export const companyGroupSummarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  externalId: z.string().nullable(),
  source: directorySourceSchema,
  memberCount: z.number().int(),
  /** The Groups its members join, by name. Only an Instance admin's mapping puts one here. */
  mappedGroups: z.array(z.object({ id: z.string(), name: z.string() })),
});

export const directoryImportFormatSchema = z.enum(["csv", "json"]);

export const directoryImportSummarySchema = z.object({
  id: z.string(),
  importedAt: z.string(),
  format: directoryImportFormatSchema,
  rowCount: z.number().int(),
  createdCount: z.number().int(),
  updatedCount: z.number().int(),
  deactivatedCount: z.number().int(),
  unchangedCount: z.number().int(),
});

/** What the Access page shows about the sync with the company's directory. */
export const directoryStatusSchema = z.object({
  tokens: z.array(directoryTokenSchema),
  /** When any token last reached the SCIM endpoints, or null if none has. */
  lastScimRequestAt: z.string().nullable(),
  /** Users who came from the directory or an import, deactivated ones included. */
  provisionedUserCount: z.number().int(),
  companyGroupCount: z.number().int(),
  /** The first 200 Company groups by name. */
  companyGroups: z.array(companyGroupSummarySchema),
  /** The latest imports, newest first. */
  recentImports: z.array(directoryImportSummarySchema),
});

/**
 * One person in an imported file. Without `companyGroups` their memberships stay as they are, and
 * an empty list removes them all. Without `active`, a new user is active and an existing one stays
 * as they are. Roles and Instance admin status cannot be imported.
 */
export const directoryImportUserSchema = z.strictObject({
  email: emailSchema,
  displayName: displayNameSchema,
  companyGroups: z.array(companyGroupNameSchema).max(100).optional(),
  active: z.boolean().optional(),
});

export const directoryImportRequestSchema = z.object({
  users: z.array(directoryImportUserSchema).min(1).max(MAXIMUM_DIRECTORY_IMPORT_ROWS),
});

/** A row the import cannot use. `row` counts a CSV file's header as row 1. */
export const directoryImportProblemSchema = z.object({
  row: z.number().int(),
  message: z.string(),
});

/** A refused file: nothing from it was applied. */
export const directoryImportFailureSchema = errorResponseSchema.extend({
  problems: z.array(directoryImportProblemSchema),
});

export type DirectorySource = z.infer<typeof directorySourceSchema>;
export type DirectoryToken = z.infer<typeof directoryTokenSchema>;
export type CreatedDirectoryToken = z.infer<typeof createdDirectoryTokenSchema>;
export type CompanyGroupSummary = z.infer<typeof companyGroupSummarySchema>;
export type DirectoryImportFormat = z.infer<typeof directoryImportFormatSchema>;
export type DirectoryImportSummary = z.infer<typeof directoryImportSummarySchema>;
export type DirectoryStatus = z.infer<typeof directoryStatusSchema>;
export type DirectoryImportUser = z.infer<typeof directoryImportUserSchema>;
export type DirectoryImportProblem = z.infer<typeof directoryImportProblemSchema>;
export type DirectoryImportFailure = z.infer<typeof directoryImportFailureSchema>;
