/**
 * Enforces the import rules from docs/architecture.md:
 *
 * - A workspace member reaches another member only by its package name, never by a relative path.
 * - Only `apps/all-in-one` may import a service package, so services stay independent.
 */
import { assertEquals } from "@std/assert";
import { readSourceImports } from "./source-imports.ts";

const SOURCE_DIRECTORIES = ["apps", "packages", "services", "tests", "examples"];
const SERVICE_PACKAGE_PATTERN = /^@extispex\/[a-z-]+-service(\/|$)/;
const MEMBERS_ALLOWED_TO_IMPORT_SERVICES = new Set(["apps/all-in-one"]);

interface ImportViolation {
  file: string;
  specifier: string;
  rule: string;
}

/** The workspace member a repository-relative path belongs to, such as `services/telemetry`. */
function findWorkspaceMember(repositoryRelativePath: string): string {
  return repositoryRelativePath.split("/").slice(0, 2).join("/");
}

async function findImportViolations(): Promise<ImportViolation[]> {
  const violations: ImportViolation[] = [];
  for await (const { file, specifier, importedFile } of readSourceImports(SOURCE_DIRECTORIES)) {
    const importingMember = findWorkspaceMember(file);
    if (importedFile !== null) {
      if (findWorkspaceMember(importedFile) !== importingMember) {
        violations.push({
          file,
          specifier,
          rule: "Import another workspace member by its package name, not by a relative path.",
        });
      }
    } else if (
      SERVICE_PACKAGE_PATTERN.test(specifier) &&
      !MEMBERS_ALLOWED_TO_IMPORT_SERVICES.has(importingMember)
    ) {
      violations.push({
        file,
        specifier,
        rule: "Only apps/all-in-one may import a service. Services talk through their APIs.",
      });
    }
  }
  return violations;
}

Deno.test("workspace members respect the import boundaries", async () => {
  assertEquals(await findImportViolations(), []);
});
