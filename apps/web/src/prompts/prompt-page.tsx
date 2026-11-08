import type { PromptSummary, PromptVersion, PromptVersionSummary } from "@extispex/contracts";
import { type FormEvent, useCallback, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import {
  getPrompt,
  getPromptVersion,
  listPromptVersions,
  movePromptLabel,
  removePromptLabel,
} from "../api/prompt-api.ts";
import { useCanEditProject } from "../sign-in/access-context.ts";
import { formatRelativeTime } from "../traces/trace-formatting.ts";
import { AlertIcon, CompareIcon, PlusIcon, TagIcon, TrashIcon } from "../ui/icons.tsx";
import { LoadError } from "../ui/load-error.tsx";
import { useApiResource } from "../ui/use-api-resource.ts";
import { useNow } from "../ui/use-now.ts";
import {
  Breadcrumbs,
  LabelBadge,
  ModelParametersView,
  newPromptVersionPath,
  promptComparisonPath,
  promptPagePath,
  PromptTemplateView,
  VariableList,
  VersionBadge,
} from "./prompt-parts.tsx";
import type { ApiCredentials } from "../api/api-request.ts";

interface PromptPageProps {
  credentials: ApiCredentials;
  onSignInRequired: () => void;
}

interface PromptWithVersions {
  prompt: PromptSummary;
  versions: PromptVersionSummary[];
}

/** One prompt: its version history beside the selected version, which is `?version=` or latest. */
export function PromptPage({ credentials, onSignInRequired }: PromptPageProps) {
  const canEdit = useCanEditProject();
  const promptName = useParams().promptName as string;
  const [searchParameters] = useSearchParams();
  const loadPromptWithVersions = useCallback(async (): Promise<PromptWithVersions> => {
    const [prompt, { versions }] = await Promise.all([
      getPrompt(credentials, promptName),
      listPromptVersions(credentials, promptName),
    ]);
    return { prompt, versions };
  }, [credentials, promptName]);
  const [promptState, reloadPrompt] = useApiResource(loadPromptWithVersions);

  if (promptState.status !== "loaded") {
    return (
      <div className="page page-constrained">
        <Breadcrumbs items={[{ label: "Prompts", path: "/prompts" }, { label: promptName }]} />
        <div className="page-header">
          <div className="page-heading">
            <h1 className="prompt-title">{promptName}</h1>
            <p className="page-subtitle">&nbsp;</p>
          </div>
        </div>
        <section className="panel">
          {promptState.status === "loading" && <div className="panel-loading" aria-busy="true" />}
          {promptState.status === "failed" && (
            <LoadError
              subject="The prompt"
              message={promptState.message}
              isSignInRequired={promptState.isSignInRequired}
              onRetry={reloadPrompt}
              onSignInRequired={onSignInRequired}
            />
          )}
        </section>
      </div>
    );
  }

  const { prompt, versions } = promptState.resource;
  const requestedVersionNumber = Number(searchParameters.get("version"));
  const selectedVersionNumber =
    versions.some((version) => version.versionNumber === requestedVersionNumber)
      ? requestedVersionNumber
      : prompt.latestVersionNumber;
  const comparisonBaseNumber = selectedVersionNumber > 1 ? selectedVersionNumber - 1 : 1;

  return (
    <div className="page page-constrained">
      <Breadcrumbs items={[{ label: "Prompts", path: "/prompts" }, { label: prompt.name }]} />
      <div className="page-header">
        <div className="page-heading">
          <h1 className="prompt-title">{prompt.name}</h1>
          <p className="page-subtitle">
            {prompt.description || "No description"} · {versions.length}{" "}
            {versions.length === 1 ? "version" : "versions"}
          </p>
        </div>
        <div className="page-actions">
          {versions.length > 1 && (
            <Link
              className="button button-secondary"
              to={promptComparisonPath(prompt.name, comparisonBaseNumber, selectedVersionNumber)}
            >
              <CompareIcon size={14} />
              Compare
            </Link>
          )}
          {canEdit && (
            <Link
              className="button button-primary"
              to={newPromptVersionPath(prompt.name, selectedVersionNumber)}
            >
              <PlusIcon size={14} />
              New version
            </Link>
          )}
        </div>
      </div>

      <div className="prompt-workspace">
        {/* Labels belong to the prompt, not to a version, so they sit beside the history. */}
        <div className="prompt-sidebar">
          <VersionHistory
            promptName={prompt.name}
            versions={versions}
            selectedVersionNumber={selectedVersionNumber}
          />
          {canEdit && (
            <PromptLabelManager
              credentials={credentials}
              prompt={prompt}
              selectedVersionNumber={selectedVersionNumber}
              onLabelsChanged={reloadPrompt}
            />
          )}
        </div>
        <SelectedVersion
          key={selectedVersionNumber}
          credentials={credentials}
          prompt={prompt}
          versionNumber={selectedVersionNumber}
        />
      </div>
    </div>
  );
}

function VersionHistory(
  { promptName, versions, selectedVersionNumber }: {
    promptName: string;
    versions: PromptVersionSummary[];
    selectedVersionNumber: number;
  },
) {
  const nowUnixMilliseconds = useNow(15_000);
  return (
    <section className="panel version-history-panel" aria-labelledby="version-history-title">
      <h2 id="version-history-title" className="panel-title">Versions</h2>
      <ol className="version-list">
        {versions.map((version) => {
          const isSelected = version.versionNumber === selectedVersionNumber;
          return (
            <li key={version.versionNumber}>
              <Link
                className={`version-item${isSelected ? " version-item-selected" : ""}`}
                to={promptPagePath(promptName, version.versionNumber)}
                aria-current={isSelected ? "true" : undefined}
              >
                <span className="version-item-heading">
                  <VersionBadge versionNumber={version.versionNumber} />
                  <span className="version-item-message">
                    {version.commitMessage ?? (
                      <span className="text-subtle">No commit message</span>
                    )}
                  </span>
                </span>
                <span className="version-item-meta">
                  <span title={new Date(version.createdAt).toLocaleString()}>
                    {formatRelativeTime(Date.parse(version.createdAt), nowUnixMilliseconds)}
                  </span>
                  {version.model !== null && <span className="service-badge">{version.model}</span>}
                </span>
                {version.labels.length > 0 && (
                  <span className="badge-list">
                    {version.labels.map((labelName) => (
                      <LabelBadge key={labelName} name={labelName} />
                    ))}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

interface SelectedVersionProps {
  credentials: ApiCredentials;
  prompt: PromptSummary;
  versionNumber: number;
}

function SelectedVersion({ credentials, prompt, versionNumber }: SelectedVersionProps) {
  const loadVersion = useCallback(
    () => getPromptVersion(credentials, prompt.name, versionNumber),
    [credentials, prompt.name, versionNumber],
  );
  const [versionState, reloadVersion] = useApiResource(loadVersion);
  // From the prompt rather than the version, so that a moved label shows here at once.
  const labelsOfVersion = prompt.labels.filter((label) => label.versionNumber === versionNumber);

  return (
    <section className="panel version-panel" aria-label={`Version ${versionNumber}`}>
      <div className="version-panel-header">
        <div className="version-panel-title">
          <p className="eyebrow">Prompt Version</p>
          <div className="version-panel-heading">
            <h2>Version {versionNumber}</h2>
            {labelsOfVersion.length > 0 && (
              <span className="badge-list" aria-label="Prompt Labels of this version">
                {labelsOfVersion.map((label) => <LabelBadge key={label.name} name={label.name} />)}
              </span>
            )}
          </div>
        </div>
        {versionState.status === "loaded" && (
          <span className="version-panel-created" title={versionState.resource.createdAt}>
            Created {new Date(versionState.resource.createdAt).toLocaleString()}
          </span>
        )}
      </div>
      <div className="version-panel-body">
        {versionState.status === "loading" && <div className="panel-loading" aria-busy="true" />}
        {versionState.status === "failed" && (
          <div className="callout callout-danger" role="alert">
            <AlertIcon size={16} />
            <div>
              <p>{versionState.message}</p>
              <button
                type="button"
                className="button button-secondary button-small"
                onClick={reloadVersion}
              >
                Try again
              </button>
            </div>
          </div>
        )}
        {versionState.status === "loaded" && <LoadedVersion version={versionState.resource} />}
      </div>
    </section>
  );
}

function LoadedVersion({ version }: { version: PromptVersion }) {
  return (
    <>
      {version.commitMessage !== null && <p className="commit-message">{version.commitMessage}</p>}
      <div className="version-section">
        <h3 className="section-title">Variables</h3>
        <VariableList variables={version.variables} />
      </div>
      <div className="version-section">
        <h3 className="section-title">{version.type === "text" ? "Text" : "Messages"}</h3>
        <PromptTemplateView version={version} />
      </div>
      <div className="version-section">
        <h3 className="section-title">Model parameters</h3>
        <ModelParametersView modelParameters={version.modelParameters} />
      </div>
    </>
  );
}

/** The prompt's labels, each with the version it points to, moved to the selected version. */
function PromptLabelManager(
  { credentials, prompt, selectedVersionNumber, onLabelsChanged }: {
    credentials: ApiCredentials;
    prompt: PromptSummary;
    selectedVersionNumber: number;
    onLabelsChanged: () => void;
  },
) {
  const versionNumber = selectedVersionNumber;
  const [newLabelName, setNewLabelName] = useState("");
  const [pendingLabelName, setPendingLabelName] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const changeLabel = async (labelName: string, change: () => Promise<unknown>) => {
    setPendingLabelName(labelName);
    setProblem(null);
    try {
      await change();
      onLabelsChanged();
      return true;
    } catch (error) {
      setProblem((error as Error).message);
      return false;
    } finally {
      setPendingLabelName(null);
    }
  };

  const addLabel = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    const labelName = newLabelName.trim();
    if (labelName === "") return;
    const hasSucceeded = await changeLabel(
      labelName,
      () => movePromptLabel(credentials, prompt.name, labelName, versionNumber),
    );
    if (hasSucceeded) setNewLabelName("");
  };

  return (
    <section className="panel label-panel" aria-labelledby="prompt-labels-title">
      <h2 id="prompt-labels-title" className="panel-title">Prompt Labels</h2>
      <div className="label-panel-body">
        <p className="label-panel-hint">
          Your application reads the version a label points to. Moving a label changes no version.
        </p>
        {prompt.labels.length > 0 && (
          <ul className="label-list">
            {prompt.labels.map((label) => {
              const pointsHere = label.versionNumber === versionNumber;
              return (
                <li
                  key={label.name}
                  className={`label-row${pointsHere ? " label-row-current" : ""}`}
                >
                  <span className="label-row-target">
                    <LabelBadge name={label.name} />
                    <span className="label-row-arrow" aria-label="points to">→</span>
                    <Link
                      to={promptPagePath(prompt.name, label.versionNumber)}
                      title={`Show version ${label.versionNumber}`}
                    >
                      <VersionBadge versionNumber={label.versionNumber} />
                    </Link>
                  </span>
                  <span className="label-row-actions">
                    {!pointsHere && (
                      <button
                        type="button"
                        className="button button-secondary button-small"
                        disabled={pendingLabelName !== null}
                        onClick={() =>
                          changeLabel(
                            label.name,
                            () =>
                              movePromptLabel(credentials, prompt.name, label.name, versionNumber),
                          )}
                      >
                        Move to v{versionNumber}
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-button button-danger"
                      disabled={pendingLabelName !== null}
                      aria-label={`Remove label ${label.name}`}
                      title={`Remove label ${label.name}`}
                      onClick={() =>
                        changeLabel(
                          label.name,
                          () => removePromptLabel(credentials, prompt.name, label.name),
                        )}
                    >
                      <TrashIcon size={14} />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <form className="inline-form label-form" onSubmit={addLabel}>
          <label htmlFor="new-label-name" className="visually-hidden">Label name</label>
          <span className="input-with-icon">
            <TagIcon size={13} />
            <input
              id="new-label-name"
              className="text-input"
              placeholder="Label, such as production"
              autoComplete="off"
              spellCheck={false}
              value={newLabelName}
              onChange={(changeEvent) => setNewLabelName(changeEvent.target.value)}
            />
          </span>
          <button
            type="submit"
            className="button button-secondary"
            disabled={newLabelName.trim() === "" || pendingLabelName !== null}
          >
            Point at v{versionNumber}
          </button>
        </form>
        {problem !== null && (
          <p className="form-problem" role="alert">
            <AlertIcon size={14} />
            {problem}
          </p>
        )}
      </div>
    </section>
  );
}
