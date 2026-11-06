import { type FormEvent, useState } from "react";

interface ApiKeyFieldProps {
  apiKey: string;
  onApiKeyChange: (apiKey: string) => void;
}

export function ApiKeyField({ apiKey, onApiKeyChange }: ApiKeyFieldProps) {
  const [draftApiKey, setDraftApiKey] = useState(apiKey);

  const saveApiKey = (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    onApiKeyChange(draftApiKey.trim());
  };

  return (
    <form className="api-key-form" onSubmit={saveApiKey}>
      <label htmlFor="api-key-input">API key</label>
      <input
        id="api-key-input"
        type="password"
        autoComplete="off"
        value={draftApiKey}
        onChange={(changeEvent) => setDraftApiKey(changeEvent.target.value)}
      />
      <button type="submit">Use key</button>
    </form>
  );
}
