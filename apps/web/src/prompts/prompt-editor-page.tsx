import type {
  CreatePromptVersionRequest,
  PromptMessageRole,
  PromptVersion,
} from "@extispex/contracts";
import { type FormEvent, type ReactNode, useCallback, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  createPrompt,
  createPromptVersion,
  getPrompt,
  getPromptVersion,
} from "../api/prompt-api.ts";
import { AlertIcon, PlusIcon, TrashIcon } from "../ui/icons.tsx";
import { LoadError } from "../ui/load-error.tsx";
import { useApiResource } from "../ui/use-api-resource.ts";
import {
  checkDraft,
  createDraftFromVersion,
  createEmptyDraft,
  findDraftVariables,
  type PromptDraft,
} from "./prompt-draft.ts";
import { Breadcrumbs, promptPagePath, ROLE_LABELS, VariableList } from "./prompt-parts.tsx";

interface EditorPageProps {
  apiKey: string;
  onDisconnect: () => void;
}

/** Creates a prompt together with its first version. */
export function NewPromptPage({ apiKey }: EditorPageProps) {
  const navigate = useNavigate();
  const [promptName, setPromptName] = useState("");
  const [description, setDescription] = useState("");

  return (
    <div className="page page-constrained">
      <Breadcrumbs items={[{ label: "Prompts", path: "/prompts" }, { label: "New prompt" }]} />
      <div className="page-header">
        <div className="page-heading">
          <h1>New prompt</h1>
          <p className="page-subtitle">This becomes version 1. Later changes are new versions.</p>
        </div>
      </div>
      <PromptVersionForm
        initialDraft={createEmptyDraft()}
        submitLabel="Create prompt"
        cancelPath="/prompts"
        promptFields={
          <div className="form-card">
            <div className="form-field">
              <label htmlFor="prompt-name" className="field-label">Name</label>
              <input
                id="prompt-name"
                className="text-input text-input-mono"
                required
                autoComplete="off"
                spellCheck={false}
                placeholder="support-agent"
                value={promptName}
                onChange={(changeEvent) => setPromptName(changeEvent.target.value)}
              />
              <p className="field-hint">
                Letters, digits, <code>.</code>, <code>_</code> and{" "}
                <code>-</code>. Your application reads the prompt by this name, so it cannot change
                later.
              </p>
            </div>
            <div className="form-field">
              <label htmlFor="prompt-description" className="field-label">
                Description <span className="text-subtle">(optional)</span>
              </label>
              <input
                id="prompt-description"
                className="text-input"
                autoComplete="off"
                placeholder="What the prompt is for"
                value={description}
                onChange={(changeEvent) => setDescription(changeEvent.target.value)}
              />
            </div>
          </div>
        }
        onSubmit={async (versionRequest) => {
          const firstVersion = await createPrompt(apiKey, {
            ...versionRequest,
            name: promptName.trim(),
            description: description.trim() || undefined,
          });
          navigate(promptPagePath(firstVersion.promptName, firstVersion.versionNumber));
        }}
      />
    </div>
  );
}

/** Adds a version, starting from the one in `?from=` or the latest. */
export function NewPromptVersionPage({ apiKey, onDisconnect }: EditorPageProps) {
  const navigate = useNavigate();
  const promptName = useParams().promptName as string;
  const [searchParameters] = useSearchParams();
  const requestedBaseNumber = Number(searchParameters.get("from")) || null;
  const loadBaseVersion = useCallback(async (): Promise<PromptVersion> => {
    const baseVersionNumber = requestedBaseNumber ??
      (await getPrompt(apiKey, promptName)).latestVersionNumber;
    return await getPromptVersion(apiKey, promptName, baseVersionNumber);
  }, [apiKey, promptName, requestedBaseNumber]);
  const [baseVersionState, reloadBaseVersion] = useApiResource(loadBaseVersion);

  return (
    <div className="page page-constrained">
      <Breadcrumbs
        items={[
          { label: "Prompts", path: "/prompts" },
          { label: promptName, path: promptPagePath(promptName) },
          { label: "New version" },
        ]}
      />
      <div className="page-header">
        <div className="page-heading">
          <h1>New version</h1>
          <p className="page-subtitle">
            {baseVersionState.status === "loaded"
              ? `Starts from version ${baseVersionState.resource.versionNumber}, which stays as it is.`
              : " "}
          </p>
        </div>
      </div>
      {baseVersionState.status === "loading" && (
        <section className="panel">
          <div className="panel-loading" aria-busy="true" />
        </section>
      )}
      {baseVersionState.status === "failed" && (
        <section className="panel">
          <LoadError
            subject="The prompt"
            message={baseVersionState.message}
            isApiKeyRejected={baseVersionState.isApiKeyRejected}
            onRetry={reloadBaseVersion}
            onDisconnect={onDisconnect}
          />
        </section>
      )}
      {baseVersionState.status === "loaded" && (
        <PromptVersionForm
          initialDraft={createDraftFromVersion(baseVersionState.resource)}
          submitLabel="Save version"
          cancelPath={promptPagePath(promptName, baseVersionState.resource.versionNumber)}
          onSubmit={async (versionRequest) => {
            const newVersion = await createPromptVersion(apiKey, promptName, versionRequest);
            navigate(promptPagePath(promptName, newVersion.versionNumber));
          }}
        />
      )}
    </div>
  );
}

interface PromptVersionFormProps {
  initialDraft: PromptDraft;
  submitLabel: string;
  cancelPath: string;
  /** Fields that belong to the prompt rather than the version, shown first. */
  promptFields?: ReactNode;
  onSubmit: (versionRequest: CreatePromptVersionRequest) => Promise<void>;
}

function PromptVersionForm(
  { initialDraft, submitLabel, cancelPath, promptFields, onSubmit }: PromptVersionFormProps,
) {
  const [draft, setDraft] = useState(initialDraft);
  const [problem, setProblem] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const updateDraft = (changes: Partial<PromptDraft>) => setDraft({ ...draft, ...changes });
  const updateMessage = (
    messageIndex: number,
    changes: Partial<{ role: PromptMessageRole; content: string }>,
  ) =>
    updateDraft({
      messages: draft.messages.map((message, index) =>
        index === messageIndex ? { ...message, ...changes } : message
      ),
    });

  const submit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    const draftCheck = checkDraft(draft);
    if (!draftCheck.isValid) {
      setProblem(draftCheck.problem);
      return;
    }
    setProblem(null);
    setIsSaving(true);
    try {
      await onSubmit(draftCheck.request);
    } catch (error) {
      setProblem((error as Error).message);
      setIsSaving(false);
    }
  };

  return (
    <form className="editor-layout" onSubmit={submit} noValidate>
      <div className="editor-main">
        {promptFields}
        <div className="form-card">
          <div className="form-card-header">
            <h2 className="section-title">Template</h2>
            <div
              className="segmented-control segmented-control-text"
              role="radiogroup"
              aria-label="Template type"
            >
              {(["chat", "text"] as const).map((templateType) => (
                <button
                  key={templateType}
                  type="button"
                  role="radio"
                  aria-checked={draft.type === templateType}
                  className="segmented-control-option"
                  onClick={() => updateDraft({ type: templateType })}
                >
                  {templateType === "chat" ? "Chat messages" : "Text"}
                </button>
              ))}
            </div>
          </div>
          {draft.type === "text"
            ? (
              <div className="form-field">
                <label htmlFor="prompt-text" className="visually-hidden">Prompt text</label>
                <AutoGrowingTextArea
                  id="prompt-text"
                  value={draft.text}
                  placeholder="Summarize the run {{run}} in three sentences."
                  onChange={(text) => updateDraft({ text })}
                />
              </div>
            )
            : (
              <ol className="message-editor-list">
                {draft.messages.map((message, messageIndex) => (
                  <li key={messageIndex} className="message-editor">
                    <div className="message-editor-header">
                      <label className="visually-hidden" htmlFor={`message-role-${messageIndex}`}>
                        Role of message {messageIndex + 1}
                      </label>
                      <select
                        id={`message-role-${messageIndex}`}
                        className="select-input"
                        value={message.role}
                        onChange={(changeEvent) =>
                          updateMessage(messageIndex, {
                            role: changeEvent.target.value as PromptMessageRole,
                          })}
                      >
                        {Object.entries(ROLE_LABELS).map(([role, roleLabel]) => (
                          <option key={role} value={role}>{roleLabel}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="icon-button button-danger"
                        aria-label={`Remove message ${messageIndex + 1}`}
                        title="Remove message"
                        disabled={draft.messages.length === 1}
                        onClick={() =>
                          updateDraft({
                            messages: draft.messages.filter((_, index) =>
                              index !== messageIndex
                            ),
                          })}
                      >
                        <TrashIcon size={14} />
                      </button>
                    </div>
                    <label className="visually-hidden" htmlFor={`message-content-${messageIndex}`}>
                      Message {messageIndex + 1}
                    </label>
                    <AutoGrowingTextArea
                      id={`message-content-${messageIndex}`}
                      value={message.content}
                      placeholder={message.role === "system"
                        ? "You help customers of {{company}}."
                        : "{{question}}"}
                      onChange={(content) => updateMessage(messageIndex, { content })}
                    />
                  </li>
                ))}
                <li>
                  <button
                    type="button"
                    className="button button-ghost button-small"
                    onClick={() =>
                      updateDraft({
                        messages: [...draft.messages, {
                          role: draft.messages.at(-1)?.role === "user" ? "assistant" : "user",
                          content: "",
                        }],
                      })}
                  >
                    <PlusIcon size={13} />
                    Add message
                  </button>
                </li>
              </ol>
            )}
          <div className="detected-variables">
            <span className="field-label">Variables</span>
            <VariableList variables={findDraftVariables(draft)} />
            <span className="field-hint">
              Write <code>{"{{name}}"}</code> where a value goes in.
            </span>
          </div>
        </div>
      </div>

      <div className="editor-side">
        <div className="form-card">
          <h2 className="section-title">Model parameters</h2>
          <div className="form-field">
            <label htmlFor="model" className="field-label">Model</label>
            <input
              id="model"
              className="text-input text-input-mono"
              autoComplete="off"
              spellCheck={false}
              placeholder="gpt-4.1"
              value={draft.model}
              onChange={(changeEvent) => updateDraft({ model: changeEvent.target.value })}
            />
          </div>
          <div className="form-field-row">
            <NumberField
              id="temperature"
              label="Temperature"
              value={draft.temperature}
              step="0.1"
              onChange={(temperature) => updateDraft({ temperature })}
            />
            <NumberField
              id="top-p"
              label="Top P"
              value={draft.topP}
              step="0.05"
              onChange={(topP) => updateDraft({ topP })}
            />
          </div>
          <NumberField
            id="max-output-tokens"
            label="Max output tokens"
            value={draft.maxOutputTokens}
            step="1"
            onChange={(maxOutputTokens) => updateDraft({ maxOutputTokens })}
          />
          <div className="form-field">
            <label htmlFor="provider-options" className="field-label">
              Provider options <span className="text-subtle">(JSON)</span>
            </label>
            <AutoGrowingTextArea
              id="provider-options"
              className="text-area-mono"
              value={draft.providerOptionsJson}
              placeholder='{ "reasoning_effort": "low" }'
              onChange={(providerOptionsJson) => updateDraft({ providerOptionsJson })}
            />
            <p className="field-hint">Passed to the provider as given.</p>
          </div>
        </div>

        <div className="form-card">
          <h2 className="section-title">Version</h2>
          <div className="form-field">
            <label htmlFor="commit-message" className="field-label">
              Commit message <span className="text-subtle">(optional)</span>
            </label>
            <input
              id="commit-message"
              className="text-input"
              autoComplete="off"
              placeholder="What changed and why"
              value={draft.commitMessage}
              onChange={(changeEvent) => updateDraft({ commitMessage: changeEvent.target.value })}
            />
          </div>
          <div className="form-field">
            <label htmlFor="label-names" className="field-label">
              Prompt Labels <span className="text-subtle">(optional)</span>
            </label>
            <input
              id="label-names"
              className="text-input text-input-mono"
              autoComplete="off"
              spellCheck={false}
              placeholder="staging"
              value={draft.labelNames}
              onChange={(changeEvent) => updateDraft({ labelNames: changeEvent.target.value })}
            />
            <p className="field-hint">Separate several with commas. They move to this version.</p>
          </div>
        </div>

        {problem !== null && (
          <div className="callout callout-danger" role="alert">
            <AlertIcon size={16} />
            <p>{problem}</p>
          </div>
        )}
        <div className="form-actions">
          <Link className="button button-ghost" to={cancelPath}>Cancel</Link>
          <button type="submit" className="button button-primary" disabled={isSaving}>
            {isSaving ? "Saving…" : submitLabel}
          </button>
        </div>
      </div>
    </form>
  );
}

function NumberField(
  { id, label, value, step, onChange }: {
    id: string;
    label: string;
    value: string;
    step: string;
    onChange: (value: string) => void;
  },
) {
  return (
    <div className="form-field">
      <label htmlFor={id} className="field-label">{label}</label>
      <input
        id={id}
        className="text-input"
        type="number"
        inputMode="decimal"
        min="0"
        step={step}
        placeholder="Not set"
        value={value}
        onChange={(changeEvent) => onChange(changeEvent.target.value)}
      />
    </div>
  );
}

/** A text area that grows with its content, so long prompts need no inner scroll bar. */
function AutoGrowingTextArea(
  { id, value, placeholder, className, onChange }: {
    id: string;
    value: string;
    placeholder?: string;
    className?: string;
    onChange: (value: string) => void;
  },
) {
  return (
    <div className={`auto-grow ${className ?? ""}`} data-value={`${value} `}>
      <textarea
        id={id}
        className="text-area"
        rows={2}
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(changeEvent) => onChange(changeEvent.target.value)}
      />
    </div>
  );
}
