/**
 * Enforces the module rule from docs/architecture.md: modules inside a service import each other
 * only through their public entry points.
 *
 * - A module is a directory directly below a service's `src/`, such as
 *   `services/telemetry/src/ingestion`, with everything below it.
 * - Its public entry point is the `mod.ts` in that directory. It re-exports what other modules may
 *   use; every other file in the module is internal.
 * - The files directly in `src/`, such as `create-service.ts`, belong to no module and also import
 *   modules only through `mod.ts`.
 * - A service's `tests/` and `scripts/` may import any of its files, so a unit test can reach an
 *   internal helper.
 */
import { assertEquals } from "@std/assert";
import { readSourceImports, type SourceImport } from "./source-imports.ts";

const SERVICE_SOURCE_PATTERN = /^services\/([a-z-]+)\/src\/(.+)$/;
const PUBLIC_ENTRY_POINT = "mod.ts";

export interface ModuleBoundaryViolation {
  file: string;
  specifier: string;
  rule: string;
}

/** Where a file sits in a service's `src/`: the service and the module, null directly in `src/`. */
function locateInService(
  repositoryRelativePath: string,
): { serviceName: string; moduleName: string | null; pathInModule: string } | null {
  const sourceMatch = repositoryRelativePath.match(SERVICE_SOURCE_PATTERN);
  if (sourceMatch === null) return null;
  const [, serviceName, pathInSource] = sourceMatch;
  const pathParts = pathInSource.split("/");
  if (pathParts.length === 1) return { serviceName, moduleName: null, pathInModule: pathInSource };
  return {
    serviceName,
    moduleName: pathParts[0],
    pathInModule: pathParts.slice(1).join("/"),
  };
}

export function findModuleBoundaryViolations(
  sourceImports: Iterable<SourceImport>,
): ModuleBoundaryViolation[] {
  const violations: ModuleBoundaryViolation[] = [];
  for (const { file, specifier, importedFile } of sourceImports) {
    if (importedFile === null) continue;
    const importer = locateInService(file);
    const imported = locateInService(importedFile);
    if (importer === null || imported === null || imported.moduleName === null) continue;
    if (importer.serviceName !== imported.serviceName) continue;
    if (importer.moduleName === imported.moduleName) continue;
    if (imported.pathInModule === PUBLIC_ENTRY_POINT) continue;
    violations.push({
      file,
      specifier,
      rule:
        `Import the ${imported.moduleName} module through its ${PUBLIC_ENTRY_POINT}, not its internal files.`,
    });
  }
  return violations;
}

Deno.test("modules inside a service import each other only through mod.ts", async () => {
  const sourceImports: SourceImport[] = [];
  for await (const sourceImport of readSourceImports(["services"])) {
    sourceImports.push(sourceImport);
  }
  assertEquals(findModuleBoundaryViolations(sourceImports), []);
});

Deno.test("the module rule tells internal files from public entry points", () => {
  const importOf = (file: string, importedFile: string | null, specifier = "./x.ts") => ({
    file,
    specifier,
    importedFile,
  });
  const violations = findModuleBoundaryViolations([
    // Allowed: through mod.ts, within one module, from a test, and package imports.
    importOf("services/telemetry/src/traces/routes.ts", "services/telemetry/src/storage/mod.ts"),
    importOf("services/telemetry/src/create-service.ts", "services/telemetry/src/logs/mod.ts"),
    importOf(
      "services/telemetry/src/storage/span-repository.ts",
      "services/telemetry/src/storage/nested/helper.ts",
    ),
    importOf("services/telemetry/tests/logs.test.ts", "services/telemetry/src/logs/internal.ts"),
    importOf("services/telemetry/src/traces/routes.ts", null, "@extispex/contracts"),
    importOf("services/telemetry/src/main.ts", "services/telemetry/src/create-service.ts"),
    // Not allowed: an internal file of another module, also from a file directly in src/.
    importOf(
      "services/telemetry/src/traces/routes.ts",
      "services/telemetry/src/storage/span-repository.ts",
      "../storage/span-repository.ts",
    ),
    importOf(
      "services/telemetry/src/create-service.ts",
      "services/telemetry/src/storage/nested/mod.ts",
      "./storage/nested/mod.ts",
    ),
  ]);
  assertEquals(violations.map((violation) => violation.specifier), [
    "../storage/span-repository.ts",
    "./storage/nested/mod.ts",
  ]);
});
