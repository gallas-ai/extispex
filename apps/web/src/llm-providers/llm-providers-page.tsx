import type {
  LlmProvider,
  LlmProviderKind,
  LlmSummarySettings,
  PromptSummary,
} from "@extispex/contracts";
import { type FormEvent, useCallback, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { ApiCredentials } from "../api/api-request.ts";
import {
  createLlmProvider,
  getLlmSummarySettings,
  listLlmProviders,
  updateLlmSummarySettings,
} from "../api/evaluation-api.ts";
import { listPrompts } from "../api/prompt-api.ts";
import { useCanEditProject } from "../sign-in/access-context.ts";
import { AlertIcon, CheckIcon, PlusIcon, SparklesIcon } from "../ui/icons.tsx";
import { LoadError } from "../ui/load-error.tsx";
import { useApiResource } from "../ui/use-api-resource.ts";
import {
  CAPABILITY_LABELS,
  DEFAULT_BASE_URLS,
  DEFAULT_MODELS,
  KIND_HINTS,
  LLM_PROVIDER_KIND_LABELS,
  llmProviderPagePath,
} from "./llm-provider-kinds.ts";

interface LlmProvidersPageProps {
  credentials: ApiCredentials;
  onSignInRequired: () => void;
}

export function LlmProvidersPage({ credentials, onSignInRequired }: LlmProvidersPageProps) {
  const canEdit = useCanEditProject();
  const loadProviders = useCallback(() => listLlmProviders(credentials), [credentials]);
  const [providersState, reloadProviders] = useApiResource(loadProviders);

  return (
    <div className="page page-constrained">
      <div className="page-header">
        <div className="page-heading">
          <h1>LLM providers</h1>
          <p className="page-subtitle">
            The models that Grading Evaluators ask for a verdict and that write each finished run's
            LLM Summary.
          </p>
        </div>
      </div>
      {canEdit && <NewLlmProviderForm credentials={credentials} />}
      <section className="panel" aria-label="LLM provider list">
        {providersState.status === "loading" && <div className="panel-loading" aria-busy="true" />}
        {providersState.status === "failed" && (
          <LoadError
            subject="LLM providers"
            message={providersState.message}
            isSignInRequired={providersState.isSignInRequired}
            onRetry={reloadProviders}
            onSignInRequired={onSignInRequired}
          />
        )}
        {providersState.status === "loaded" && providersState.resource.llmProviders.length === 0 &&
          (
            <div className="empty-state">
              <span className="empty-state-icon">
                <SparklesIcon size={22} />
              </span>
              <h2>No LLM providers yet</h2>
              <p>Add one to use Grading Evaluators and LLM Summaries.</p>
            </div>
          )}
        {providersState.status === "loaded" && providersState.resource.llmProviders.length > 0 && (
          <LlmProviderTable providers={providersState.resource.llmProviders} />
        )}
      </section>
      {providersState.status === "loaded" && (
        <LlmSummarySettingsPanel
          credentials={credentials}
          providers={providersState.resource.llmProviders}
          canEdit={canEdit}
        />
      )}
    </div>
  );
}

function NewLlmProviderForm({ credentials }: { credentials: ApiCredentials }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<LlmProviderKind>("openai_compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    if (name.trim() === "") {
      setProblem("Give the LLM provider a name.");
      return;
    }
    setIsCreating(true);
    setProblem(null);
    try {
      const provider = await createLlmProvider(credentials, {
        name: name.trim(),
        kind,
        ...(baseUrl.trim() === "" ? {} : { baseUrl: baseUrl.trim() }),
        ...(apiKey === "" ? {} : { apiKey }),
        defaultModel: defaultModel.trim() === "" ? DEFAULT_MODELS[kind] : defaultModel.trim(),
      });
      navigate(llmProviderPagePath(provider.name));
    } catch (error) {
      setProblem((error as Error).message);
      setIsCreating(false);
    }
  };

  return (
    <section className="panel panel-form" aria-label="New LLM provider">
      <form className="llm-provider-form" onSubmit={submit} noValidate>
        <div className="form-field-row">
          <div className="form-field">
            <label className="field-label" htmlFor="new-llm-provider-name">Name</label>
            <input
              id="new-llm-provider-name"
              className="text-input"
              placeholder="judge"
              autoComplete="off"
              spellCheck={false}
              value={name}
              onChange={(changeEvent) => setName(changeEvent.target.value)}
            />
          </div>
          <div className="form-field">
            <label className="field-label" htmlFor="new-llm-provider-kind">Kind</label>
            <select
              id="new-llm-provider-kind"
              className="select-input"
              value={kind}
              onChange={(changeEvent) => setKind(changeEvent.target.value as LlmProviderKind)}
            >
              {(Object.keys(LLM_PROVIDER_KIND_LABELS) as LlmProviderKind[]).map((option) => (
                <option key={option} value={option}>{LLM_PROVIDER_KIND_LABELS[option]}</option>
              ))}
            </select>
          </div>
        </div>
        <p className="field-hint">{KIND_HINTS[kind]}</p>
        <div className="form-field-row">
          <div className="form-field">
            <label className="field-label" htmlFor="new-llm-provider-url">Base URL</label>
            <input
              id="new-llm-provider-url"
              className="text-input text-input-mono"
              placeholder={DEFAULT_BASE_URLS[kind]}
              autoComplete="off"
              spellCheck={false}
              value={baseUrl}
              onChange={(changeEvent) => setBaseUrl(changeEvent.target.value)}
            />
          </div>
          <div className="form-field">
            <label className="field-label" htmlFor="new-llm-provider-model">Default model</label>
            <input
              id="new-llm-provider-model"
              className="text-input text-input-mono"
              placeholder={DEFAULT_MODELS[kind]}
              autoComplete="off"
              spellCheck={false}
              value={defaultModel}
              onChange={(changeEvent) => setDefaultModel(changeEvent.target.value)}
            />
          </div>
        </div>
        <div className="form-field">
          <label className="field-label" htmlFor="new-llm-provider-key">API key</label>
          <input
            id="new-llm-provider-key"
            className="text-input text-input-mono"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            placeholder={kind === "openai_compatible" ? "Optional for a local model" : "Required"}
            value={apiKey}
            onChange={(changeEvent) => setApiKey(changeEvent.target.value)}
          />
        </div>
        <p className="field-hint">
          The API key is stored encrypted and never shown again. A Prompt Version's model overrides
          the default model. The worker calls only the addresses that
          EVALUATION_LLM_PROVIDER_ALLOWED_DESTINATIONS allows.
        </p>
        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={isCreating}>
            <PlusIcon size={14} />
            Add LLM provider
          </button>
        </div>
      </form>
      {problem !== null && (
        <p className="form-problem" role="alert">
          <AlertIcon size={14} />
          {problem}
        </p>
      )}
    </section>
  );
}

function LlmProviderTable({ providers }: { providers: LlmProvider[] }) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">LLM provider</th>
            <th scope="col">Kind</th>
            <th scope="col">Capabilities</th>
            <th scope="col">Default model</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((provider) => (
            <tr key={provider.name}>
              <td className="cell-breaks-anywhere">
                <Link to={llmProviderPagePath(provider.name)}>{provider.name}</Link>
              </td>
              <td>{LLM_PROVIDER_KIND_LABELS[provider.kind]}</td>
              <td className="text-muted">
                {provider.capabilities.map((capability) => CAPABILITY_LABELS[capability]).join(
                  ", ",
                )}
              </td>
              <td className="cell-breaks-anywhere">
                <code>{provider.defaultModel}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Which provider and prompt write the LLM Summary of each run that finishes from now on. */
function LlmSummarySettingsPanel(
  { credentials, providers, canEdit }: {
    credentials: ApiCredentials;
    providers: LlmProvider[];
    canEdit: boolean;
  },
) {
  const loadSettings = useCallback(async () => {
    const [settings, { prompts }] = await Promise.all([
      getLlmSummarySettings(credentials),
      listPrompts(credentials),
    ]);
    return { settings, prompts };
  }, [credentials]);
  const [settingsState, reloadSettings] = useApiResource(loadSettings);

  return (
    <section className="panel panel-form" aria-label="LLM Summary">
      <h2 className="section-title">LLM Summary</h2>
      <p className="field-hint">
        Every finished Evaluation Run gets an overview written by this provider, with the default
        prompt or your own Prompt Version. The run's verdict never depends on it.
      </p>
      {settingsState.status === "loading" && <div className="panel-loading" aria-busy="true" />}
      {settingsState.status === "failed" && (
        <p className="form-problem" role="alert">
          <AlertIcon size={14} />
          {settingsState.message}
        </p>
      )}
      {settingsState.status === "loaded" && (
        <LlmSummarySettingsForm
          key="settings"
          credentials={credentials}
          settings={settingsState.resource.settings}
          providers={providers.filter((provider) =>
            provider.capabilities.includes("text_generation")
          )}
          prompts={settingsState.resource.prompts}
          canEdit={canEdit}
          onSaved={reloadSettings}
        />
      )}
    </section>
  );
}

function LlmSummarySettingsForm(
  { credentials, settings, providers, prompts, canEdit, onSaved }: {
    credentials: ApiCredentials;
    settings: LlmSummarySettings;
    providers: LlmProvider[];
    prompts: PromptSummary[];
    canEdit: boolean;
    onSaved: () => void;
  },
) {
  const [providerName, setProviderName] = useState(settings.providerName ?? "");
  const [promptName, setPromptName] = useState(settings.prompt?.name ?? "");
  const [promptVersion, setPromptVersion] = useState(
    settings.prompt === null ? "" : String(settings.prompt.version),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [isSaved, setIsSaved] = useState(false);
  const selectedPrompt = prompts.find((prompt) => prompt.name === promptName);

  const submit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    setProblem(null);
    setIsSaved(false);
    try {
      await updateLlmSummarySettings(credentials, {
        providerName: providerName === "" ? null : providerName,
        prompt: promptName === ""
          ? null
          : { name: promptName, version: Number(promptVersion) || 1 },
      });
      setIsSaved(true);
      onSaved();
    } catch (error) {
      setProblem((error as Error).message);
    }
  };

  return (
    <form className="llm-summary-form" onSubmit={submit} noValidate>
      <div className="form-field-row">
        <div className="form-field">
          <label className="field-label" htmlFor="llm-summary-provider">Summary provider</label>
          <select
            id="llm-summary-provider"
            className="select-input"
            disabled={!canEdit}
            value={providerName}
            onChange={(changeEvent) => setProviderName(changeEvent.target.value)}
          >
            <option value="">No LLM Summary</option>
            {providers.map((provider) => (
              <option key={provider.name} value={provider.name}>{provider.name}</option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label className="field-label" htmlFor="llm-summary-prompt">Summary prompt</label>
          <select
            id="llm-summary-prompt"
            className="select-input"
            disabled={!canEdit}
            value={promptName}
            onChange={(changeEvent) => {
              const prompt = prompts.find((option) => option.name === changeEvent.target.value);
              setPromptName(changeEvent.target.value);
              setPromptVersion(prompt === undefined ? "" : String(prompt.latestVersionNumber));
            }}
          >
            <option value="">The default prompt</option>
            {prompts.map((prompt) => (
              <option key={prompt.name} value={prompt.name}>{prompt.name}</option>
            ))}
          </select>
        </div>
        {selectedPrompt !== undefined && (
          <div className="form-field">
            <label className="field-label" htmlFor="llm-summary-prompt-version">Version</label>
            <select
              id="llm-summary-prompt-version"
              className="select-input"
              disabled={!canEdit}
              value={promptVersion}
              onChange={(changeEvent) => setPromptVersion(changeEvent.target.value)}
            >
              {Array.from({ length: selectedPrompt.latestVersionNumber }, (_, index) => {
                const versionNumber = selectedPrompt.latestVersionNumber - index;
                return (
                  <option key={versionNumber} value={String(versionNumber)}>
                    Version {versionNumber}
                  </option>
                );
              })}
            </select>
          </div>
        )}
      </div>
      <p className="field-hint">
        Your own prompt gets the run's results as {"{{results}}"}, and may use {"{{datasetName}}"}
        {" "}
        and {"{{verdict}}"}.
      </p>
      {problem !== null && (
        <p className="form-problem" role="alert">
          <AlertIcon size={14} />
          {problem}
        </p>
      )}
      {isSaved && (
        <p className="form-success" role="status">
          <CheckIcon size={14} /> Saved.
        </p>
      )}
      {canEdit && (
        <div className="form-actions">
          <button type="submit" className="button button-primary">Save LLM Summary settings</button>
        </div>
      )}
    </form>
  );
}
