/**
 * Lint rule that enforces the project convention: every declared name states its purpose, so
 * single-letter names are reported. `_` stays allowed for deliberately unused values.
 */
const MINIMUM_NAME_LENGTH = 2;
const ALLOWED_SHORT_NAMES = new Set(["_"]);

/** Any AST node that can declare names; parameter properties are outside `Deno.lint.Node`. */
type PatternNode = { type: string } | null | undefined;

const descriptiveNamesPlugin: Deno.lint.Plugin = {
  name: "descriptive-names",
  rules: {
    "no-single-letter-names": {
      create(context) {
        const reportShortNames = (patternNode: PatternNode) => {
          for (const identifier of collectDeclaredIdentifiers(patternNode)) {
            if (
              identifier.name.length < MINIMUM_NAME_LENGTH &&
              !ALLOWED_SHORT_NAMES.has(identifier.name)
            ) {
              context.report({
                node: identifier,
                message:
                  `"${identifier.name}" does not describe its purpose. Use a descriptive name.`,
              });
            }
          }
        };
        const reportFunctionNames = (
          functionNode:
            | Deno.lint.FunctionDeclaration
            | Deno.lint.FunctionExpression
            | Deno.lint.ArrowFunctionExpression,
        ) => {
          if ("id" in functionNode) {
            reportShortNames(functionNode.id);
          }
          for (const parameter of functionNode.params) {
            reportShortNames(parameter);
          }
        };
        return {
          VariableDeclarator: (declarator) => reportShortNames(declarator.id),
          FunctionDeclaration: reportFunctionNames,
          FunctionExpression: reportFunctionNames,
          ArrowFunctionExpression: reportFunctionNames,
          CatchClause: (catchClause) => reportShortNames(catchClause.param),
          ClassDeclaration: (classDeclaration) => reportShortNames(classDeclaration.id),
          TSTypeParameter: (typeParameter) => reportShortNames(typeParameter.name),
        };
      },
    },
  },
};

/** Returns the identifiers a declaration introduces, including those inside destructuring. */
function collectDeclaredIdentifiers(patternNode: PatternNode): Deno.lint.Identifier[] {
  if (!patternNode) {
    return [];
  }
  switch (patternNode.type) {
    case "Identifier":
      return [patternNode as Deno.lint.Identifier];
    case "ObjectPattern":
      return (patternNode as Deno.lint.ObjectPattern).properties.flatMap((property) =>
        property.type === "RestElement"
          ? collectDeclaredIdentifiers(property.argument)
          : collectDeclaredIdentifiers(property.value)
      );
    case "ArrayPattern":
      return (patternNode as Deno.lint.ArrayPattern).elements.flatMap((element) =>
        collectDeclaredIdentifiers(element)
      );
    case "AssignmentPattern":
      return collectDeclaredIdentifiers((patternNode as Deno.lint.AssignmentPattern).left);
    case "RestElement":
      return collectDeclaredIdentifiers((patternNode as Deno.lint.RestElement).argument);
    case "TSParameterProperty":
      return collectDeclaredIdentifiers(
        (patternNode as { parameter?: { type: string } }).parameter,
      );
    default:
      return [];
  }
}

export default descriptiveNamesPlugin;
