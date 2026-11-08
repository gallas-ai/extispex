import type {
  ContentChange,
  ModelParameterChange,
  PromptVersionComparison,
  PromptVersionSummary,
} from "@extispex/contracts";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { comparePromptVersions, listPromptVersions } from "../api/prompt-api.ts";
import { AlertIcon, CheckIcon, ChevronRightIcon, SwapIcon } from "../ui/icons.tsx";
import { LoadError } from "../ui/load-error.tsx";
import { useApiResource } from "../ui/use-api-resource.ts";
import {
  Breadcrumbs,
  formatParameterValue,
  MODEL_PARAMETER_LABELS,
  promptComparisonPath,
  promptPagePath,
  ROLE_LABELS,
} from "./prompt-parts.tsx";
import type { ApiCredentials } from "../api/api-request.ts";

interface PromptComparisonPageProps {
  credentials: ApiCredentials;
  onSignInRequired: () => void;
}

/** Two versions of one prompt side by side: what changed in the text and the model parameters. */
export function PromptComparisonPage({ credentials, onSignInRequired }: PromptComparisonPageProps) {
  const promptName = useParams().promptName as string;
  const navigate = useNavigate();
  const [searchParameters] = useSearchParams();
  const fromVersionNumber = Number(searchParameters.get("fromVersion")) || null;
  const toVersionNumber = Number(searchParameters.get("toVersion")) || null;

  const loadVersions = useCallback(() => listPromptVersions(credentials, promptName), [
    credentials,
    promptName,
  ]);
  const [versionsState, reloadVersions] = useApiResource(loadVersions);

  // Without both numbers, compare the latest version with the one before it.
  useEffect(() => {
    if (versionsState.status !== "loaded") return;
    if (fromVersionNumber !== null && toVersionNumber !== null) return;
    const [latestVersion, previousVersion] = versionsState.resource.versions;
    navigate(
      promptComparisonPath(
        promptName,
        (previousVersion ?? latestVersion).versionNumber,
        latestVersion.versionNumber,
      ),
      { replace: true },
    );
  }, [versionsState, fromVersionNumber, toVersionNumber, navigate, promptName]);

  const selectVersions = (nextFromVersion: number, nextToVersion: number) =>
    navigate(promptComparisonPath(promptName, nextFromVersion, nextToVersion), { replace: true });

  return (
    <div className="page page-constrained">
      <Breadcrumbs
        items={[
          { label: "Prompts", path: "/prompts" },
          { label: promptName, path: promptPagePath(promptName) },
          { label: "Compare" },
        ]}
      />
      <div className="page-header">
        <div className="page-heading">
          <h1>Compare versions</h1>
          <p className="page-subtitle">Text and model parameters of two versions of {promptName}</p>
        </div>
      </div>

      {versionsState.status === "failed" && (
        <section className="panel">
          <LoadError
            subject="The prompt"
            message={versionsState.message}
            isSignInRequired={versionsState.isSignInRequired}
            onRetry={reloadVersions}
            onSignInRequired={onSignInRequired}
          />
        </section>
      )}
      {versionsState.status === "loading" && (
        <section className="panel">
          <div className="panel-loading" aria-busy="true" />
        </section>
      )}
      {versionsState.status === "loaded" && fromVersionNumber !== null &&
        toVersionNumber !== null && (
        <>
          <VersionPicker
            versions={versionsState.resource.versions}
            fromVersionNumber={fromVersionNumber}
            toVersionNumber={toVersionNumber}
            onSelect={selectVersions}
          />
          <ComparisonResult
            credentials={credentials}
            promptName={promptName}
            fromVersionNumber={fromVersionNumber}
            toVersionNumber={toVersionNumber}
          />
        </>
      )}
    </div>
  );
}

function VersionPicker(
  { versions, fromVersionNumber, toVersionNumber, onSelect }: {
    versions: PromptVersionSummary[];
    fromVersionNumber: number;
    toVersionNumber: number;
    onSelect: (fromVersion: number, toVersion: number) => void;
  },
) {
  const versionOptions = versions.map((version) => (
    <option key={version.versionNumber} value={version.versionNumber}>
      v{version.versionNumber}
      {version.commitMessage ? ` · ${version.commitMessage}` : ""}
      {version.labels.length > 0 ? ` (${version.labels.join(", ")})` : ""}
    </option>
  ));
  return (
    <div className="version-picker">
      <div className="form-field">
        <label htmlFor="from-version" className="field-label">From</label>
        <select
          id="from-version"
          className="select-input"
          value={fromVersionNumber}
          onChange={(changeEvent) => onSelect(Number(changeEvent.target.value), toVersionNumber)}
        >
          {versionOptions}
        </select>
      </div>
      <button
        type="button"
        className="icon-button version-picker-swap"
        aria-label="Swap the versions"
        title="Swap the versions"
        onClick={() => onSelect(toVersionNumber, fromVersionNumber)}
      >
        <SwapIcon size={15} />
      </button>
      <div className="form-field">
        <label htmlFor="to-version" className="field-label">To</label>
        <select
          id="to-version"
          className="select-input"
          value={toVersionNumber}
          onChange={(changeEvent) => onSelect(fromVersionNumber, Number(changeEvent.target.value))}
        >
          {versionOptions}
        </select>
      </div>
    </div>
  );
}

function ComparisonResult(
  { credentials, promptName, fromVersionNumber, toVersionNumber }: {
    credentials: ApiCredentials;
    promptName: string;
    fromVersionNumber: number;
    toVersionNumber: number;
  },
) {
  const loadComparison = useCallback(
    () => comparePromptVersions(credentials, promptName, fromVersionNumber, toVersionNumber),
    [credentials, promptName, fromVersionNumber, toVersionNumber],
  );
  const [comparisonState, reloadComparison] = useApiResource(loadComparison);

  if (comparisonState.status === "loading") {
    return (
      <section className="panel">
        <div className="panel-loading" aria-busy="true" />
      </section>
    );
  }
  if (comparisonState.status === "failed") {
    return (
      <div className="callout callout-danger" role="alert">
        <AlertIcon size={16} />
        <div>
          <p>{comparisonState.message}</p>
          <button
            type="button"
            className="button button-secondary button-small"
            onClick={reloadComparison}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
  return <ComparisonView comparison={comparisonState.resource} />;
}

function ComparisonView({ comparison }: { comparison: PromptVersionComparison }) {
  const { fromVersion, toVersion } = comparison;
  const changedLineCount = comparison.contentChanges.reduce(
    (lineCount, contentChange) =>
      lineCount + contentChange.lines.filter((line) => line.change !== "unchanged").length,
    0,
  );
  const changedParameters = comparison.modelParameterChanges.filter((parameterChange) =>
    parameterChange.change !== "unchanged"
  );

  return (
    <div className="comparison">
      <p className={`comparison-summary${comparison.hasChanges ? "" : " comparison-summary-same"}`}>
        {comparison.hasChanges
          ? (
            <>
              <strong>{describeCount(changedLineCount, "line")}</strong> and{" "}
              <strong>{describeCount(changedParameters.length, "model parameter")}</strong>{" "}
              changed from v{fromVersion.versionNumber} to v{toVersion.versionNumber}.
              {fromVersion.type !== toVersion.type &&
                ` The template changed from ${fromVersion.type} to ${toVersion.type}.`}
            </>
          )
          : (
            <>
              <CheckIcon size={14} />
              v{fromVersion.versionNumber} and v{toVersion.versionNumber} are identical.
            </>
          )}
      </p>

      <section className="panel comparison-section" aria-labelledby="parameter-changes-title">
        <h2 id="parameter-changes-title" className="panel-title">Model parameters</h2>
        <ParameterChangeTable
          parameterChanges={comparison.modelParameterChanges}
          fromVersionNumber={fromVersion.versionNumber}
          toVersionNumber={toVersion.versionNumber}
        />
      </section>

      <section className="panel comparison-section" aria-labelledby="content-changes-title">
        <h2 id="content-changes-title" className="panel-title">
          {toVersion.type === "text" && fromVersion.type === "text" ? "Text" : "Messages"}
        </h2>
        <div className="content-changes">
          {comparison.contentChanges.map((contentChange, changeIndex) => (
            <ContentChangeView key={changeIndex} contentChange={contentChange} />
          ))}
        </div>
      </section>
    </div>
  );
}

function describeCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function ParameterChangeTable(
  { parameterChanges, fromVersionNumber, toVersionNumber }: {
    parameterChanges: ModelParameterChange[];
    fromVersionNumber: number;
    toVersionNumber: number;
  },
) {
  return (
    <div className="parameter-changes" role="table" aria-label="Model parameter changes">
      <div className="parameter-change parameter-change-heading" role="row">
        <span role="columnheader">Parameter</span>
        <span role="columnheader">v{fromVersionNumber}</span>
        <span role="columnheader">v{toVersionNumber}</span>
      </div>
      {parameterChanges.map((parameterChange) => (
        <div
          key={parameterChange.parameter}
          className={`parameter-change parameter-change-${parameterChange.change}`}
          role="row"
        >
          <span role="rowheader" className="parameter-change-name">
            {MODEL_PARAMETER_LABELS[parameterChange.parameter] ?? (
              <code>{parameterChange.parameter}</code>
            )}
          </span>
          <span role="cell" className="parameter-change-from">
            {formatParameterValue(parameterChange.fromValue)}
          </span>
          <span role="cell" className="parameter-change-to">
            {formatParameterValue(parameterChange.toValue)}
          </span>
        </div>
      ))}
    </div>
  );
}

const CHANGE_LABELS: Record<ContentChange["change"], string> = {
  unchanged: "Unchanged",
  changed: "Changed",
  added: "Added",
  removed: "Removed",
};

function ContentChangeView({ contentChange }: { contentChange: ContentChange }) {
  const role = contentChange.toRole ?? contentChange.fromRole;
  const [isExpanded, setIsExpanded] = useState(contentChange.change !== "unchanged");
  const heading = role === null ? "Text" : ROLE_LABELS[role];

  return (
    <article className={`content-change content-change-${contentChange.change}`}>
      <button
        type="button"
        className="content-change-header"
        aria-expanded={isExpanded}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <ChevronRightIcon size={14} className={isExpanded ? "chevron-open" : undefined} />
        <span className="content-change-role">{heading}</span>
        <span className={`change-badge change-badge-${contentChange.change}`}>
          {CHANGE_LABELS[contentChange.change]}
        </span>
        <span className="content-change-size text-subtle">
          {describeCount(contentChange.lines.length, "line")}
        </span>
      </button>
      {isExpanded && (
        <div className="diff-lines" role="table" aria-label={`${heading} lines`}>
          {contentChange.lines.map((line, lineIndex) => (
            <div key={lineIndex} className={`diff-line diff-line-${line.change}`} role="row">
              <span className="diff-line-number" role="cell">{line.fromLineNumber ?? ""}</span>
              <span className="diff-line-number" role="cell">{line.toLineNumber ?? ""}</span>
              <span className="diff-line-sign" role="cell" aria-label={line.change}>
                {line.change === "added" ? "+" : line.change === "removed" ? "−" : ""}
              </span>
              <span className="diff-line-text" role="cell">{line.text || " "}</span>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
