import type {
  ChangeKind,
  ContentChange,
  DiffLine,
  ModelParameterChange,
  ModelParameters,
  PromptMessageRole,
  PromptVersion,
  PromptVersionComparison,
} from "@extispex/contracts";
import { diffArrays } from "diff";

/** A chat message, or the whole text of a text prompt with no role. */
interface ContentSegment {
  role: PromptMessageRole | null;
  content: string;
}

const TYPED_MODEL_PARAMETERS = ["model", "temperature", "maxOutputTokens", "topP"] as const;

/**
 * Compares two versions of one prompt. Messages are first matched as a whole, so that an inserted
 * message does not make every later one look changed. Messages that differ at the same position
 * with the same role are then compared line by line.
 */
export function comparePromptVersions(
  fromVersion: PromptVersion,
  toVersion: PromptVersion,
): PromptVersionComparison {
  const contentChanges = compareContent(toSegments(fromVersion), toSegments(toVersion));
  const modelParameterChanges = compareModelParameters(
    fromVersion.modelParameters,
    toVersion.modelParameters,
  );
  const hasChanges = fromVersion.type !== toVersion.type ||
    contentChanges.some((contentChange) => contentChange.change !== "unchanged") ||
    modelParameterChanges.some((parameterChange) => parameterChange.change !== "unchanged");
  return {
    promptName: toVersion.promptName,
    fromVersion,
    toVersion,
    hasChanges,
    contentChanges,
    modelParameterChanges,
  };
}

function toSegments(version: PromptVersion): ContentSegment[] {
  return version.type === "text"
    ? [{ role: null, content: version.text }]
    : version.messages.map((message) => ({ role: message.role, content: message.content }));
}

function compareContent(
  fromSegments: ContentSegment[],
  toSegments: ContentSegment[],
): ContentChange[] {
  const segmentChanges = diffArrays(fromSegments, toSegments, {
    comparator: (fromSegment, toSegment) =>
      fromSegment.role === toSegment.role && fromSegment.content === toSegment.content,
  });
  const contentChanges: ContentChange[] = [];
  let removedSegments: ContentSegment[] = [];
  let addedSegments: ContentSegment[] = [];
  const flushReplacedSegments = () => {
    contentChanges.push(...pairReplacedSegments(removedSegments, addedSegments));
    removedSegments = [];
    addedSegments = [];
  };
  for (const segmentChange of segmentChanges) {
    if (segmentChange.removed) {
      removedSegments.push(...segmentChange.value);
    } else if (segmentChange.added) {
      addedSegments.push(...segmentChange.value);
    } else {
      flushReplacedSegments();
      for (const segment of segmentChange.value) {
        contentChanges.push(describeWholeSegment("unchanged", segment));
      }
    }
  }
  flushReplacedSegments();
  return contentChanges;
}

/** Pairs removed and added segments at the same position when their roles match. */
function pairReplacedSegments(
  removedSegments: ContentSegment[],
  addedSegments: ContentSegment[],
): ContentChange[] {
  const contentChanges: ContentChange[] = [];
  const pairCount = Math.max(removedSegments.length, addedSegments.length);
  for (let position = 0; position < pairCount; position++) {
    const removedSegment = removedSegments[position];
    const addedSegment = addedSegments[position];
    if (removedSegment && addedSegment && removedSegment.role === addedSegment.role) {
      contentChanges.push({
        change: "changed",
        fromRole: removedSegment.role,
        toRole: addedSegment.role,
        lines: compareLines(removedSegment.content, addedSegment.content),
      });
      continue;
    }
    if (removedSegment) contentChanges.push(describeWholeSegment("removed", removedSegment));
    if (addedSegment) contentChanges.push(describeWholeSegment("added", addedSegment));
  }
  return contentChanges;
}

function describeWholeSegment(
  change: "unchanged" | "added" | "removed",
  segment: ContentSegment,
): ContentChange {
  const lines = segment.content.split("\n").map((text, lineIndex): DiffLine => ({
    change,
    text,
    fromLineNumber: change === "added" ? null : lineIndex + 1,
    toLineNumber: change === "removed" ? null : lineIndex + 1,
  }));
  return {
    change,
    fromRole: change === "added" ? null : segment.role,
    toRole: change === "removed" ? null : segment.role,
    lines,
  };
}

export function compareLines(fromText: string, toText: string): DiffLine[] {
  const diffLines: DiffLine[] = [];
  let fromLineNumber = 1;
  let toLineNumber = 1;
  for (const lineChange of diffArrays(fromText.split("\n"), toText.split("\n"))) {
    for (const text of lineChange.value) {
      if (lineChange.removed) {
        diffLines.push({
          change: "removed",
          text,
          fromLineNumber: fromLineNumber++,
          toLineNumber: null,
        });
      } else if (lineChange.added) {
        diffLines.push({
          change: "added",
          text,
          fromLineNumber: null,
          toLineNumber: toLineNumber++,
        });
      } else {
        diffLines.push({
          change: "unchanged",
          text,
          fromLineNumber: fromLineNumber++,
          toLineNumber: toLineNumber++,
        });
      }
    }
  }
  return diffLines;
}

/** Every typed parameter, then each provider option present in either version, by name. */
export function compareModelParameters(
  fromParameters: ModelParameters,
  toParameters: ModelParameters,
): ModelParameterChange[] {
  const parameterChanges = TYPED_MODEL_PARAMETERS.map((parameter) =>
    describeParameterChange(parameter, fromParameters[parameter], toParameters[parameter])
  );
  const providerOptionNames = [
    ...new Set([
      ...Object.keys(fromParameters.providerOptions),
      ...Object.keys(toParameters.providerOptions),
    ]),
  ].sort();
  for (const optionName of providerOptionNames) {
    parameterChanges.push(describeParameterChange(
      `providerOptions.${optionName}`,
      fromParameters.providerOptions[optionName] ?? null,
      toParameters.providerOptions[optionName] ?? null,
    ));
  }
  return parameterChanges;
}

function describeParameterChange(
  parameter: string,
  fromValue: unknown,
  toValue: unknown,
): ModelParameterChange {
  let change: ChangeKind;
  if (stringifyCanonically(fromValue) === stringifyCanonically(toValue)) {
    change = "unchanged";
  } else if (fromValue === null) {
    change = "added";
  } else if (toValue === null) {
    change = "removed";
  } else {
    change = "changed";
  }
  return { parameter, change, fromValue, toValue };
}

/** JSON with object keys sorted, so that key order does not count as a change. */
function stringifyCanonically(value: unknown): string {
  return JSON.stringify(
    value,
    (_, nestedValue) =>
      nestedValue !== null && typeof nestedValue === "object" && !Array.isArray(nestedValue)
        ? Object.fromEntries(
          Object.entries(nestedValue).sort(([firstKey], [secondKey]) =>
            firstKey.localeCompare(secondKey)
          ),
        )
        : nestedValue,
  );
}
