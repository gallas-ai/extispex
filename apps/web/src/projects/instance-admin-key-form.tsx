import { type FormEvent, useState } from "react";
import { AlertIcon, EyeIcon, EyeOffIcon, ShieldIcon } from "../ui/icons.tsx";

interface InstanceAdminKeyFormProps {
  onSubmit: (instanceAdminKey: string) => void;
  /** Why the stored key is asked for again, such as a rejected key; null on the first visit. */
  problem: string | null;
}

/** Asks for the Instance admin key, which managing Projects and API keys needs until sign-in. */
export function InstanceAdminKeyForm({ onSubmit, problem }: InstanceAdminKeyFormProps) {
  const [draftKey, setDraftKey] = useState("");
  const [isKeyVisible, setIsKeyVisible] = useState(false);

  const submit = (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    const trimmedKey = draftKey.trim();
    if (trimmedKey !== "") onSubmit(trimmedKey);
  };

  return (
    <section className="panel admin-key-panel" aria-labelledby="admin-key-title">
      <span className="admin-key-icon">
        <ShieldIcon size={20} />
      </span>
      <h2 id="admin-key-title" className="admin-key-title">Enter the Instance admin key</h2>
      <p className="admin-key-lead">
        Managing Projects and API keys needs the key set in{" "}
        <code>INSTANCE_ADMIN_KEY</code>. The local image generates one on first start, logs it and
        keeps it in <code>/data/instance-admin-key</code>. The key is kept in this browser only.
      </p>
      <form className="admin-key-form" onSubmit={submit}>
        <label htmlFor="instance-admin-key-input" className="field-label">
          Instance admin key
        </label>
        <div className="input-with-action">
          <input
            id="instance-admin-key-input"
            className="text-input text-input-mono"
            type={isKeyVisible ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            placeholder="extispex_admin_…"
            autoFocus
            value={draftKey}
            onChange={(changeEvent) => setDraftKey(changeEvent.target.value)}
          />
          <button
            type="button"
            className="icon-button input-action"
            onClick={() => setIsKeyVisible(!isKeyVisible)}
            aria-label={isKeyVisible ? "Hide Instance admin key" : "Show Instance admin key"}
            title={isKeyVisible ? "Hide key" : "Show key"}
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
        <button type="submit" className="button button-primary">Continue</button>
      </form>
    </section>
  );
}
