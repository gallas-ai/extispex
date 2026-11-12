import type { LlmProvider } from "@extispex/contracts";
import { type FormEvent, useCallback, useState } from "react";
import { useNavigate, useParams } from "react-router";
import type { ApiCredentials } from "../api/api-request.ts";
import { deleteLlmProvider, getLlmProvider, updateLlmProvider } from "../api/evaluation-api.ts";
import { Breadcrumbs } from "../prompts/prompt-parts.tsx";
import { useCanEditProject } from "../sign-in/access-context.ts";
import { AlertIcon, CheckIcon, TrashIcon } from "../ui/icons.tsx";
import { LoadError } from "../ui/load-error.tsx";
import { useApiResource } from "../ui/use-api-resource.ts";
import { CAPABILITY_LABELS, LLM_PROVIDER_KIND_LABELS } from "./llm-provider-kinds.ts";

interface LlmProviderPageProps {
  credentials: ApiCredentials;
  onSignInRequired: () => void;
}

export function LlmProviderPage({ credentials, onSignInRequired }: LlmProviderPageProps) {
  const providerName = useParams().providerName as string;
  const loadProvider = useCallback(
    () => getLlmProvider(credentials, providerName),
    [credentials, providerName],
  );
  const [providerState, reloadProvider] = useApiResource(loadProvider);

  return (
    <div className="page page-constrained">
      <Breadcrumbs
        items={[{ label: "LLM providers", path: "/llm-providers" }, { label: providerName }]}
      />
      <div className="page-header">
        <div className="page-heading">
          <h1 className="prompt-title">{providerName}</h1>
          <p className="page-subtitle">
            {providerState.status === "loaded"
              ? `${LLM_PROVIDER_KIND_LABELS[providerState.resource.kind]} · ${
                providerState.resource.capabilities.map((capability) =>
                  CAPABILITY_LABELS[capability]
                ).join(", ")
              }`
              : "A change applies to the next call."}
          </p>
        </div>
      </div>
      {providerState.status === "loading" && (
        <section className="panel">
          <div className="panel-loading" aria-busy="true" />
        </section>
      )}
      {providerState.status === "failed" && (
        <section className="panel">
          <LoadError
            subject="The LLM provider"
            message={providerState.message}
            isSignInRequired={providerState.isSignInRequired}
            onRetry={reloadProvider}
            onSignInRequired={onSignInRequired}
          />
        </section>
      )}
      {providerState.status === "loaded" && (
        <LlmProviderForm
          credentials={credentials}
          provider={providerState.resource}
          onSaved={reloadProvider}
        />
      )}
    </div>
  );
}

type ApiKeyChoice = "keep" | "replace" | "remove";

function LlmProviderForm(
  { credentials, provider, onSaved }: {
    credentials: ApiCredentials;
    provider: LlmProvider;
    onSaved: () => void;
  },
) {
  const canEdit = useCanEditProject();
  const navigate = useNavigate();
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [defaultModel, setDefaultModel] = useState(provider.defaultModel);
  const [description, setDescription] = useState(provider.description);
  const [apiKeyChoice, setApiKeyChoice] = useState<ApiKeyChoice>(
    provider.hasApiKey ? "keep" : "remove",
  );
  const [apiKey, setApiKey] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [isSaved, setIsSaved] = useState(false);
  const choices: ApiKeyChoice[] = provider.hasApiKey
    ? ["keep", "replace", "remove"]
    : ["remove", "replace"];

  const submit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    setProblem(null);
    setIsSaved(false);
    if (apiKeyChoice === "replace" && apiKey === "") {
      setProblem("Enter the new API key, or keep the stored one.");
      return;
    }
    try {
      await updateLlmProvider(credentials, provider.name, {
        baseUrl: baseUrl.trim(),
        defaultModel: defaultModel.trim(),
        description,
        ...(apiKeyChoice === "keep" ? {} : { apiKey: apiKeyChoice === "remove" ? null : apiKey }),
      });
      setIsSaved(true);
      setApiKey("");
      if (apiKeyChoice === "replace") setApiKeyChoice("keep");
      onSaved();
    } catch (error) {
      setProblem((error as Error).message);
    }
  };

  const remove = async () => {
    setProblem(null);
    try {
      await deleteLlmProvider(credentials, provider.name);
      navigate("/llm-providers");
    } catch (error) {
      setProblem((error as Error).message);
    }
  };

  return (
    <form className="form-card llm-provider-form" onSubmit={submit} noValidate>
      <div className="form-field">
        <label className="field-label" htmlFor="llm-provider-url">Base URL</label>
        <input
          id="llm-provider-url"
          className="text-input text-input-mono"
          autoComplete="off"
          spellCheck={false}
          disabled={!canEdit}
          value={baseUrl}
          onChange={(changeEvent) => setBaseUrl(changeEvent.target.value)}
        />
      </div>
      <div className="form-field">
        <label className="field-label" htmlFor="llm-provider-model">Default model</label>
        <input
          id="llm-provider-model"
          className="text-input text-input-mono"
          autoComplete="off"
          spellCheck={false}
          disabled={!canEdit}
          value={defaultModel}
          onChange={(changeEvent) => setDefaultModel(changeEvent.target.value)}
        />
      </div>
      <div className="form-field">
        <label className="field-label" htmlFor="llm-provider-description">Description</label>
        <textarea
          id="llm-provider-description"
          className="text-area"
          rows={2}
          disabled={!canEdit}
          value={description}
          onChange={(changeEvent) => setDescription(changeEvent.target.value)}
        />
      </div>
      <div className="form-field">
        <span className="field-label" id="llm-provider-key-label">API key</span>
        <p className="status-text">
          {provider.hasApiKey ? "An API key is stored encrypted." : "No API key is stored."}
        </p>
        {canEdit && (
          <div
            className="segmented-control segmented-control-text"
            role="radiogroup"
            aria-labelledby="llm-provider-key-label"
          >
            {choices.map((choice) => (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={apiKeyChoice === choice}
                className="segmented-control-option"
                onClick={() => setApiKeyChoice(choice)}
              >
                {{ keep: "Keep", replace: "Replace", remove: "None" }[choice]}
              </button>
            ))}
          </div>
        )}
      </div>
      {apiKeyChoice === "replace" && (
        <div className="form-field">
          <label className="field-label" htmlFor="llm-provider-key">New API key</label>
          <input
            id="llm-provider-key"
            className="text-input text-input-mono"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={apiKey}
            onChange={(changeEvent) => setApiKey(changeEvent.target.value)}
          />
        </div>
      )}
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
          <button type="button" className="button button-secondary" onClick={remove}>
            <TrashIcon size={14} />
            Delete LLM provider
          </button>
          <button type="submit" className="button button-primary">Save LLM provider</button>
        </div>
      )}
    </form>
  );
}
