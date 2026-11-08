import type { PromptSummary } from "@extispex/contracts";
import { useCallback } from "react";
import { Link, useNavigate } from "react-router";
import { listPrompts } from "../api/prompt-api.ts";
import { useCanEditProject } from "../sign-in/access-context.ts";
import { formatRelativeTime } from "../traces/trace-formatting.ts";
import { PlusIcon, PromptIcon } from "../ui/icons.tsx";
import { LoadError } from "../ui/load-error.tsx";
import { useApiResource } from "../ui/use-api-resource.ts";
import { useNow } from "../ui/use-now.ts";
import { LabelBadge, promptPagePath, VersionBadge } from "./prompt-parts.tsx";
import type { ApiCredentials } from "../api/api-request.ts";

interface PromptsPageProps {
  credentials: ApiCredentials;
  onSignInRequired: () => void;
}

export const NEW_PROMPT_PATH = "/new-prompt";

export function PromptsPage({ credentials, onSignInRequired }: PromptsPageProps) {
  const canEdit = useCanEditProject();
  const loadPrompts = useCallback(() => listPrompts(credentials), [credentials]);
  const [promptsState, reloadPrompts] = useApiResource(loadPrompts);

  return (
    <div className="page page-constrained">
      <div className="page-header">
        <div className="page-heading">
          <h1>Prompts</h1>
          <p className="page-subtitle">
            {promptsState.status === "loaded"
              ? `${promptsState.resource.prompts.length} ${
                promptsState.resource.prompts.length === 1 ? "prompt" : "prompts"
              }, most recently changed first`
              : " "}
          </p>
        </div>
        {canEdit && (
          <div className="page-actions">
            <Link className="button button-primary" to={NEW_PROMPT_PATH}>
              <PlusIcon size={14} />
              New prompt
            </Link>
          </div>
        )}
      </div>

      <section className="panel prompt-list-panel" aria-label="Prompt list">
        {promptsState.status === "loading" && <PromptTableSkeleton />}
        {promptsState.status === "failed" && (
          <LoadError
            subject="Prompts"
            message={promptsState.message}
            isSignInRequired={promptsState.isSignInRequired}
            onRetry={reloadPrompts}
            onSignInRequired={onSignInRequired}
          />
        )}
        {promptsState.status === "loaded" && promptsState.resource.prompts.length === 0 && (
          <div className="empty-state">
            <span className="empty-state-icon">
              <PromptIcon size={22} />
            </span>
            <h2>No prompts yet</h2>
            <p>
              Store a prompt with its model parameters. Every change becomes a new version, and
              labels such as <code>production</code> point to the version your application uses.
            </p>
            {canEdit && (
              <Link className="button button-primary" to={NEW_PROMPT_PATH}>
                <PlusIcon size={14} />
                Create a prompt
              </Link>
            )}
          </div>
        )}
        {promptsState.status === "loaded" && promptsState.resource.prompts.length > 0 && (
          <PromptTable prompts={promptsState.resource.prompts} />
        )}
      </section>
    </div>
  );
}

function PromptTable({ prompts }: { prompts: PromptSummary[] }) {
  const navigate = useNavigate();
  const nowUnixMilliseconds = useNow(15_000);
  return (
    <div className="table-scroll">
      <table className="data-table prompt-table">
        <thead>
          <tr>
            <th scope="col">Prompt</th>
            <th scope="col" className="column-labels">Labels</th>
            <th scope="col" className="column-numeric">Version</th>
            <th scope="col" className="column-numeric column-updated">Updated</th>
          </tr>
        </thead>
        <tbody>
          {prompts.map((prompt) => (
            <tr
              key={prompt.name}
              className="prompt-row"
              onClick={(clickEvent) => {
                // The name is a real link; a click anywhere else on the row does the same.
                if ((clickEvent.target as HTMLElement).closest("a") === null) {
                  navigate(promptPagePath(prompt.name));
                }
              }}
            >
              <td className="prompt-cell">
                <Link className="prompt-cell-name" to={promptPagePath(prompt.name)}>
                  {prompt.name}
                </Link>
                <span className="prompt-cell-description text-subtle">
                  {prompt.description || "No description"}
                </span>
              </td>
              <td className="column-labels">
                {prompt.labels.length === 0
                  ? <span className="text-subtle">—</span>
                  : (
                    <span className="badge-list">
                      {prompt.labels.map((label) => (
                        <LabelBadge
                          key={label.name}
                          name={label.name}
                          versionNumber={label.versionNumber}
                        />
                      ))}
                    </span>
                  )}
              </td>
              <td className="column-numeric">
                <VersionBadge versionNumber={prompt.latestVersionNumber} />
              </td>
              <td
                className="column-numeric column-updated text-muted"
                title={new Date(prompt.updatedAt).toLocaleString()}
              >
                {formatRelativeTime(Date.parse(prompt.updatedAt), nowUnixMilliseconds)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PromptTableSkeleton() {
  return (
    <table className="data-table" aria-hidden="true">
      <tbody>
        {Array.from({ length: 4 }, (_, rowIndex) => (
          <tr key={rowIndex} className="skeleton-row">
            <td>
              <span className="skeleton skeleton-text-wide" />
              <span className="skeleton skeleton-text-narrow" />
            </td>
            <td>
              <span className="skeleton skeleton-number" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
