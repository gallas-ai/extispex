import { type FormEvent, useState } from "react";
import { BrandMark, EyeIcon, EyeOffIcon } from "../ui/icons.tsx";

/** The key the local image accepts unless STATIC_API_KEYS is set. */
const LOCAL_DEVELOPMENT_API_KEY = "local-development-key";

interface ConnectProjectProps {
  onConnect: (apiKey: string) => void;
}

/** Shown instead of the app until the browser has an API key, which decides the Project. */
export function ConnectProject({ onConnect }: ConnectProjectProps) {
  const [draftApiKey, setDraftApiKey] = useState("");
  const [isKeyVisible, setIsKeyVisible] = useState(false);

  const connect = (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    const trimmedApiKey = draftApiKey.trim();
    if (trimmedApiKey !== "") onConnect(trimmedApiKey);
  };

  return (
    <div className="connect-page">
      <section className="connect-card" aria-labelledby="connect-title">
        <BrandMark size={44} />
        <h1 id="connect-title">Connect to your Project</h1>
        <p className="connect-lead">
          Extispex shows the traces of the Project your API key belongs to. The key is kept in this
          browser only.
        </p>
        <form className="connect-form" onSubmit={connect}>
          <label htmlFor="api-key-input" className="field-label">API key</label>
          <div className="input-with-action">
            <input
              id="api-key-input"
              className="text-input"
              type={isKeyVisible ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste your API key"
              autoFocus
              value={draftApiKey}
              onChange={(changeEvent) => setDraftApiKey(changeEvent.target.value)}
            />
            <button
              type="button"
              className="icon-button input-action"
              onClick={() => setIsKeyVisible(!isKeyVisible)}
              aria-label={isKeyVisible ? "Hide API key" : "Show API key"}
              title={isKeyVisible ? "Hide API key" : "Show API key"}
            >
              {isKeyVisible ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}
            </button>
          </div>
          <button type="submit" className="button button-primary button-block">
            Connect
          </button>
        </form>
        <div className="connect-hint">
          <p>
            Running the local image? Its built-in key is <code>{LOCAL_DEVELOPMENT_API_KEY}</code>
            {" "}
            unless <code>STATIC_API_KEYS</code> is set.
          </p>
          <button
            type="button"
            className="button button-ghost button-small"
            onClick={() => onConnect(LOCAL_DEVELOPMENT_API_KEY)}
          >
            Use the local key
          </button>
        </div>
      </section>
    </div>
  );
}
