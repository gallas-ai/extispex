import { type FormEvent, useState } from "react";
import { ApiError } from "../api/api-request.ts";
import { signIn } from "../api/sign-in-api.ts";
import { AlertIcon, BrandMark, EyeIcon, EyeOffIcon } from "../ui/icons.tsx";

interface SignInPageProps {
  onSignedIn: () => void;
  /** Why the page shows, such as an ended sign-in; null on a first visit. */
  notice: string | null;
}

/** Shown instead of the app until the browser is signed in. */
export function SignInPage({ onSignedIn, notice }: SignInPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    if (email.trim() === "" || password === "") {
      setProblem("Enter your email address and password.");
      return;
    }
    setIsSigningIn(true);
    setProblem(null);
    try {
      await signIn({ email: email.trim(), password });
      onSignedIn();
    } catch (error) {
      setProblem(
        error instanceof ApiError && error.statusCode === 400
          ? "Enter a valid email address."
          : (error as Error).message,
      );
      setIsSigningIn(false);
    }
  };

  return (
    <div className="connect-page">
      <section className="connect-card" aria-labelledby="sign-in-title">
        <BrandMark size={44} />
        <h1 id="sign-in-title">Sign in to Extispex</h1>
        <p className="connect-lead">
          {notice ?? "Your Groups decide which Projects you see and what you may change."}
        </p>
        <form className="connect-form" onSubmit={submit}>
          <label htmlFor="sign-in-email-input" className="field-label">Email</label>
          <input
            id="sign-in-email-input"
            className="text-input"
            type="email"
            autoComplete="username"
            spellCheck={false}
            autoFocus
            value={email}
            onChange={(changeEvent) => setEmail(changeEvent.target.value)}
          />
          <label htmlFor="sign-in-password-input" className="field-label sign-in-password-label">
            Password
          </label>
          <div className="input-with-action">
            <input
              id="sign-in-password-input"
              className="text-input"
              type={isPasswordVisible ? "text" : "password"}
              autoComplete="current-password"
              value={password}
              onChange={(changeEvent) => setPassword(changeEvent.target.value)}
            />
            <button
              type="button"
              className="icon-button input-action"
              onClick={() => setIsPasswordVisible(!isPasswordVisible)}
              aria-label={isPasswordVisible ? "Hide password" : "Show password"}
              title={isPasswordVisible ? "Hide password" : "Show password"}
            >
              {isPasswordVisible ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}
            </button>
          </div>
          {problem !== null && (
            <p className="form-problem" role="alert">
              <AlertIcon size={14} />
              {problem}
            </p>
          )}
          <button
            type="submit"
            className="button button-primary button-block"
            disabled={isSigningIn}
          >
            {isSigningIn ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <div className="connect-hint">
          <p>
            A new local instance creates the administrator <code>admin@extispex.local</code>{" "}
            and logs the password once, on first start. It also keeps it in{" "}
            <code>/data/initial-admin-password</code>.
          </p>
        </div>
      </section>
    </div>
  );
}
