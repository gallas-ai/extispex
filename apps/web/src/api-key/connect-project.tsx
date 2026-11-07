import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { AlertIcon, BrandMark, EyeIcon, EyeOffIcon } from "../ui/icons.tsx";
import { INSTANCE_ADMIN_KEY_PREFIX } from "./api-key-storage.ts";

interface ConnectProjectProps {
  onConnect: (apiKey: string) => void;
}

/** Shown instead of the app until the browser has an API key, which decides the Project. */
export function ConnectProject({ onConnect }: ConnectProjectProps) {
  const [draftApiKey, setDraftApiKey] = useState("");
  const [isKeyVisible, setIsKeyVisible] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const connect = (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    const trimmedApiKey = draftApiKey.trim();
    if (trimmedApiKey === "") return;
    if (trimmedApiKey.startsWith(INSTANCE_ADMIN_KEY_PREFIX)) {
      setProblem("This is the Instance admin key. Use it under Projects to create an API key.");
      return;
    }
    onConnect(trimmedApiKey);
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
          {problem !== null && (
            <p className="form-problem" role="alert">
              <AlertIcon size={14} />
              {problem}
            </p>
          )}
          <button type="submit" className="button button-primary button-block">
            Connect
          </button>
        </form>
        <div className="connect-hint">
          <p>
            A new instance creates the Project <code>Default</code>{" "}
            and logs its API key once, on first start. Create more keys under Projects with the
            Instance admin key.
          </p>
          <Link className="button button-ghost button-small" to="/projects">
            Manage Projects and API keys
          </Link>
        </div>
      </section>
    </div>
  );
}
