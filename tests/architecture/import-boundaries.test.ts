/**
 * Enforces the import rules from docs/architecture.md:
 *
 * - A workspace member reaches another member only by its package name, never by a relative path.
 * - Only `apps/all-in-one` may import a service package, so services stay independent.
 */
import { assertEquals } from "@std/assert";
import { walk } from "@std/fs/walk";
import { relative } from "@std/path";

const REPOSITORY_ROOT = new URL("../../", import.meta.url).pathname;
const SOURCE_DIRECTORIES = ["apps", "packages", "services", "tests", "examples"];
const SERVICE_PACKAGE_PATTERN = /^@evaluation-telemetry\/[a-z-]+-service(\/|$)/;
const MEMBERS_ALLOWED_TO_IMPORT_SERVICES = new Set(["apps/all-in-one"]);
const IMPORT_SPECIFIER_PATTERN =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

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
  for (const sourceDirectory of SOURCE_DIRECTORIES) {
    const sourceFiles = walk(`${REPOSITORY_ROOT}${sourceDirectory}`, {
      exts: [".ts", ".tsx"],
      skip: [/node_modules/, /\/dist\//, /\/generated\//],
    });
    for await (const sourceFile of sourceFiles) {
      const repositoryRelativePath = relative(REPOSITORY_ROOT, sourceFile.path);
      const importingMember = findWorkspaceMember(repositoryRelativePath);
      const sourceText = await Deno.readTextFile(sourceFile.path);
      for (const importMatch of sourceText.matchAll(IMPORT_SPECIFIER_PATTERN)) {
        const specifier = importMatch[1] ?? importMatch[2];
        if (specifier.startsWith(".")) {
          const importedPath = relative(
            REPOSITORY_ROOT,
            new URL(specifier, `file://${sourceFile.path}`).pathname,
          );
          if (findWorkspaceMember(importedPath) !== importingMember) {
            violations.push({
              file: repositoryRelativePath,
              specifier,
              rule: "Import another workspace member by its package name, not by a relative path.",
            });
          }
        } else if (
          SERVICE_PACKAGE_PATTERN.test(specifier) &&
          !MEMBERS_ALLOWED_TO_IMPORT_SERVICES.has(importingMember)
        ) {
          violations.push({
            file: repositoryRelativePath,
            specifier,
            rule: "Only apps/all-in-one may import a service. Services talk through their APIs.",
          });
        }
      }
    }
  }
  return violations;
}

Deno.test("workspace members respect the import boundaries", async () => {
  assertEquals(await findImportViolations(), []);
});
