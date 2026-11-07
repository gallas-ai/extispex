import type { ModelParameters, PromptMessageRole, PromptVersion } from "@extispex/contracts";
import { Link } from "react-router";
import { TagIcon } from "../ui/icons.tsx";

export function promptPagePath(promptName: string, versionNumber?: number): string {
  const path = `/prompts/${encodeURIComponent(promptName)}`;
  return versionNumber === undefined ? path : `${path}?version=${versionNumber}`;
}

export function promptComparisonPath(
  promptName: string,
  fromVersion: number,
  toVersion: number,
): string {
  return `${promptPagePath(promptName)}/compare?fromVersion=${fromVersion}&toVersion=${toVersion}`;
}

export function newPromptVersionPath(promptName: string, baseVersionNumber: number): string {
  return `${promptPagePath(promptName)}/versions/new?from=${baseVersionNumber}`;
}

export const ROLE_LABELS: Record<PromptMessageRole, string> = {
  system: "System",
  user: "User",
  assistant: "Assistant",
};

/** A Prompt Label, optionally with the version it points to. */
export function LabelBadge({ name, versionNumber }: { name: string; versionNumber?: number }) {
  return (
    <span className="label-badge">
      <TagIcon size={11} />
      <span className="label-badge-name">{name}</span>
      {versionNumber !== undefined && <span className="label-badge-version">v{versionNumber}</span>}
    </span>
  );
}

export function VersionBadge({ versionNumber }: { versionNumber: number }) {
  return <span className="version-badge">v{versionNumber}</span>;
}

export function VariableList({ variables }: { variables: string[] }) {
  if (variables.length === 0) {
    return <span className="text-subtle">None</span>;
  }
  return (
    <span className="badge-list">
      {variables.map((variableName) => (
        <code key={variableName} className="variable-badge">{`{{${variableName}}}`}</code>
      ))}
    </span>
  );
}

/** The prompt's text, or its messages one after another with their roles. */
export function PromptTemplateView({ version }: { version: PromptVersion }) {
  if (version.type === "text") {
    return <pre className="prompt-text">{version.text}</pre>;
  }
  return (
    <ol className="prompt-messages" aria-label="Messages">
      {version.messages.map((message, messageIndex) => (
        <li key={messageIndex} className={`prompt-message prompt-message-${message.role}`}>
          <span className="prompt-message-role">{ROLE_LABELS[message.role]}</span>
          <pre className="prompt-text">{message.content}</pre>
        </li>
      ))}
    </ol>
  );
}

export function formatParameterValue(parameterValue: unknown): string {
  if (parameterValue === null || parameterValue === undefined) return "—";
  if (typeof parameterValue === "string") return parameterValue;
  if (typeof parameterValue === "number") return parameterValue.toLocaleString("en-US");
  return JSON.stringify(parameterValue);
}

export const MODEL_PARAMETER_LABELS: Record<string, string> = {
  model: "Model",
  temperature: "Temperature",
  maxOutputTokens: "Max output tokens",
  topP: "Top P",
};

export function ModelParametersView({ modelParameters }: { modelParameters: ModelParameters }) {
  const providerOptionNames = Object.keys(modelParameters.providerOptions);
  return (
    <>
      <dl className="property-grid property-grid-fit">
        {(["model", "temperature", "maxOutputTokens", "topP"] as const).map((parameter) => (
          <div key={parameter} className="property">
            <dt>{MODEL_PARAMETER_LABELS[parameter]}</dt>
            <dd title={formatParameterValue(modelParameters[parameter])}>
              {modelParameters[parameter] === null
                ? <span className="text-subtle">Not set</span>
                : formatParameterValue(modelParameters[parameter])}
            </dd>
          </div>
        ))}
      </dl>
      {providerOptionNames.length > 0 && (
        <div className="provider-options">
          <p className="field-label">Provider options</p>
          <pre className="attribute-json">
            {JSON.stringify(modelParameters.providerOptions, null, 2)}
          </pre>
        </div>
      )}
    </>
  );
}

export function Breadcrumbs({ items }: { items: { label: string; path?: string }[] }) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumbs">
      <ol>
        {items.map((item, itemIndex) => (
          <li key={itemIndex}>
            {item.path === undefined
              ? <span aria-current="page">{item.label}</span>
              : <Link to={item.path}>{item.label}</Link>}
          </li>
        ))}
      </ol>
    </nav>
  );
}
