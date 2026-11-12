import { walk } from "@std/fs/walk";
import { relative } from "@std/path";

export const REPOSITORY_ROOT = new URL("../../", import.meta.url).pathname;

const IMPORT_SPECIFIER_PATTERN =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

export interface SourceImport {
  /** The importing file, relative to the repository root. */
  file: string;
  /** The specifier as written, such as `../storage/mod.ts` or `@extispex/contracts`. */
  specifier: string;
  /** For a relative specifier, the imported file relative to the repository root; otherwise null. */
  importedFile: string | null;
}

/** Every static and dynamic import and re-export in the TypeScript files under the directories. */
export async function* readSourceImports(
  repositoryRelativeDirectories: string[],
): AsyncGenerator<SourceImport> {
  for (const sourceDirectory of repositoryRelativeDirectories) {
    const sourceFiles = walk(`${REPOSITORY_ROOT}${sourceDirectory}`, {
      exts: [".ts", ".tsx"],
      skip: [/node_modules/, /\/dist\//, /\/generated\//],
    });
    for await (const sourceFile of sourceFiles) {
      const file = relative(REPOSITORY_ROOT, sourceFile.path);
      const sourceText = await Deno.readTextFile(sourceFile.path);
      for (const importMatch of sourceText.matchAll(IMPORT_SPECIFIER_PATTERN)) {
        const specifier = importMatch[1] ?? importMatch[2];
        const importedFile = specifier.startsWith(".")
          ? relative(REPOSITORY_ROOT, new URL(specifier, `file://${sourceFile.path}`).pathname)
          : null;
        yield { file, specifier, importedFile };
      }
    }
  }
}
