import { type FormEvent, useState } from "react";
import { MINIMUM_PASSWORD_LENGTH } from "../access/access-rules.ts";
import { isSignInRequired } from "../api/api-request.ts";
import { changeOwnPassword } from "../api/sign-in-api.ts";
import { AlertIcon } from "../ui/icons.tsx";
import { useAccess } from "./access-context.ts";

/** A local account's own settings: its password. */
export function AccountPage() {
  const { showSignIn } = useAccess();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [isChanging, setIsChanging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [isChanged, setIsChanged] = useState(false);

  const submit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    setIsChanged(false);
    if (newPassword.length < MINIMUM_PASSWORD_LENGTH) {
      setProblem(`The new password needs at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
      return;
    }
    setIsChanging(true);
    setProblem(null);
    try {
      await changeOwnPassword({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setIsChanged(true);
    } catch (error) {
      if (isSignInRequired(error)) {
        showSignIn();
      } else {
        setProblem((error as Error).message);
      }
    } finally {
      setIsChanging(false);
    }
  };

  return (
    <div className="page page-constrained">
      <div className="page-header">
        <div className="page-heading">
          <h1>Account</h1>
          <p className="page-subtitle">
            Changing your password signs you out in your other browsers.
          </p>
        </div>
      </div>
      <section className="panel" aria-labelledby="password-title">
        <h2 id="password-title" className="panel-title">Change password</h2>
        <form className="panel-form account-form" onSubmit={submit}>
          <label htmlFor="current-password-input" className="field-label">Current password</label>
          <input
            id="current-password-input"
            className="text-input"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(changeEvent) => setCurrentPassword(changeEvent.target.value)}
          />
          <label htmlFor="new-password-input" className="field-label">New password</label>
          <input
            id="new-password-input"
            className="text-input"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(changeEvent) => setNewPassword(changeEvent.target.value)}
          />
          {problem !== null && (
            <p className="form-problem" role="alert">
              <AlertIcon size={14} />
              {problem}
            </p>
          )}
          {isChanged && <p className="form-success" role="status">Your password is changed.</p>}
          <button type="submit" className="button button-primary" disabled={isChanging}>
            {isChanging ? "Changing…" : "Change password"}
          </button>
        </form>
      </section>
    </div>
  );
}
