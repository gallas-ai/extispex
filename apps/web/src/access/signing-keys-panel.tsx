import type { SigningKey } from "@extispex/contracts";
import { useState } from "react";
import { activateSigningKey, addSigningKey, retireSigningKey } from "../api/identity-api.ts";
import { useAccess } from "../sign-in/access-context.ts";
import { formatRelativeTime } from "../traces/trace-formatting.ts";
import { AlertIcon, PlusIcon } from "../ui/icons.tsx";
import { useNow } from "../ui/use-now.ts";

const STATE_LABELS: Record<SigningKey["state"], string> = {
  signing: "Signing",
  published: "Published",
  retired: "Retired",
};

/**
 * The keys that sign access tokens. Rotating takes two steps: add a key, which every service can
 * read at once, and let it sign a minute later. The key it replaces is removed once the tokens it
 * signed have expired.
 */
export function SigningKeysPanel(
  { keys, onChange }: { keys: SigningKey[]; onChange: () => void },
) {
  const { credentials } = useAccess();
  const nowUnixMilliseconds = useNow(5_000);
  const [problem, setProblem] = useState<string | null>(null);
  const [isChanging, setIsChanging] = useState(false);

  const runChange = async (makeChange: () => Promise<unknown>) => {
    setIsChanging(true);
    setProblem(null);
    try {
      await makeChange();
      onChange();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setIsChanging(false);
    }
  };

  const describeKey = (key: SigningKey): string => {
    if (key.state === "retired" && key.removedAt !== null) {
      return `Removed ${formatRelativeTime(Date.parse(key.removedAt), nowUnixMilliseconds)}`;
    }
    if (key.state === "signing") {
      const since = key.activatedAt ?? key.createdAt;
      return `Since ${formatRelativeTime(Date.parse(since), nowUnixMilliseconds)}`;
    }
    const canSignFrom = Date.parse(key.canSignFrom);
    return canSignFrom > nowUnixMilliseconds
      ? `Can sign ${formatRelativeTime(canSignFrom, nowUnixMilliseconds)}`
      : "Ready to sign";
  };

  return (
    <section className="panel signing-keys-panel" aria-labelledby="signing-keys-title">
      <h2 id="signing-keys-title" className="panel-title">Signing keys</h2>
      <p className="signing-key-summary">
        These keys sign the access tokens that every service checks. To rotate, add a key, and let
        it sign once services have had a minute to read it. The key it replaces stays until the
        tokens it signed have expired.
      </p>
      <div className="signing-key-toolbar">
        <button
          type="button"
          className="button button-secondary"
          disabled={isChanging}
          onClick={() => runChange(() => addSigningKey(credentials))}
        >
          <PlusIcon size={14} />
          Add key
        </button>
      </div>
      {problem !== null && (
        <p className="form-problem" role="alert">
          <AlertIcon size={14} />
          {problem}
        </p>
      )}
      <div className="table-scroll">
        <table className="data-table api-key-table signing-key-table">
          <thead>
            <tr>
              <th scope="col" className="column-key">Key ID</th>
              <th scope="col">State</th>
              <th scope="col">When</th>
              <th scope="col" className="column-actions">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr
                key={key.keyId}
                className={key.state === "retired" ? "api-key-row api-key-revoked" : "api-key-row"}
              >
                <td className="column-key">
                  <code className="api-key-prefix">{key.keyId}</code>
                </td>
                <td>{STATE_LABELS[key.state]}</td>
                <td className="text-muted">{describeKey(key)}</td>
                <td className="column-actions">
                  {key.state === "published" && (
                    <div className="signing-key-actions">
                      <button
                        type="button"
                        className="button button-ghost button-small"
                        disabled={isChanging || Date.parse(key.canSignFrom) > nowUnixMilliseconds}
                        aria-label={`Sign with ${key.keyId}`}
                        onClick={() => runChange(() => activateSigningKey(credentials, key.keyId))}
                      >
                        Sign with it
                      </button>
                      <button
                        type="button"
                        className="button button-ghost button-danger button-small"
                        disabled={isChanging}
                        aria-label={`Retire ${key.keyId}`}
                        onClick={() => runChange(() => retireSigningKey(credentials, key.keyId))}
                      >
                        Retire
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
