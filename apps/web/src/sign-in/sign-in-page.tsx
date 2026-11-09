import type { OidcSignInFailure, SignInOptions } from "@extispex/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { useLocation } from "react-router";
import { ApiError } from "../api/api-request.ts";
import { getSignInOptions, signIn } from "../api/sign-in-api.ts";
import { AlertIcon, BrandMark, EyeIcon, EyeOffIcon } from "../ui/icons.tsx";

interface SignInPageProps {
  onSignedIn: () => void;
  /** Why the page shows, such as an ended sign-in; null on a first visit. */
  notice: string | null;
}

/** Kept in step with `packages/contracts`, from which the UI imports only types (ADR 0006). */
const OIDC_START_PATH = "/v1/sign-in/oidc/authorize";
const SIGN_IN_FAILURE_PARAMETER = "signInError";

const OIDC_FAILURE_MESSAGES: Record<OidcSignInFailure, string> = {
  oidc_disabled: "Signing in with a company account is not set up on this Instance.",
  attempt_expired: "That sign-in took too long or was already used. Please try again.",
  provider_unavailable: "The identity provider could not be reached. Please try again shortly.",
  provider_refused: "The identity provider did not confirm your sign-in. Please try again.",
  email_missing: "The identity provider did not give a verified email address for your account.",
  email_taken: "Another user already has your email address. Ask an Instance admin for help.",
  user_deactivated: "Your user is deactivated. Ask an Instance admin for help.",
};

/** The address's sign-in failure, once; removes it so that a reload does not show it again. */
function takeOidcFailureMessage(): string | null {
  const address = new URL(globalThis.location.href);
  const failure = address.searchParams.get(SIGN_IN_FAILURE_PARAMETER);
  if (failure === null) return null;
  address.searchParams.delete(SIGN_IN_FAILURE_PARAMETER);
  globalThis.history.replaceState(null, "", address);
  return OIDC_FAILURE_MESSAGES[failure as OidcSignInFailure] ??
    OIDC_FAILURE_MESSAGES.provider_refused;
}

/** Without an answer the password form shows, and submitting it reports what is wrong. */
const FALLBACK_SIGN_IN_OPTIONS: SignInOptions = {
  areLocalAccountsEnabled: true,
  oidcProviderName: null,
};

/** Shown instead of the app until the browser is signed in. */
export function SignInPage({ onSignedIn, notice }: SignInPageProps) {
  const { pathname, search } = useLocation();
  const [options, setOptions] = useState<SignInOptions | null>(null);
  const [oidcFailure] = useState(takeOidcFailureMessage);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let isCurrent = true;
    getSignInOptions()
      .catch(() => FALLBACK_SIGN_IN_OPTIONS)
      .then((loadedOptions) => {
        if (isCurrent) setOptions(loadedOptions);
      });
    return () => {
      isCurrent = false;
    };
  }, []);

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
        {oidcFailure !== null && (
          <p className="form-problem sign-in-failure" role="alert">
            <AlertIcon size={14} />
            {oidcFailure}
          </p>
        )}
        {options?.oidcProviderName != null && (
          <a
            className="button button-primary button-block sign-in-provider"
            href={`${OIDC_START_PATH}?returnTo=${encodeURIComponent(pathname + search)}`}
          >
            Sign in with {options.oidcProviderName}
          </a>
        )}
        {options?.oidcProviderName != null && options.areLocalAccountsEnabled && (
          <p className="sign-in-divider">or with a local account</p>
        )}
        {options?.areLocalAccountsEnabled && (
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
        )}
        {options?.areLocalAccountsEnabled && (
          <div className="connect-hint">
            <p>
              A new local instance creates the administrator <code>admin@extispex.local</code>{" "}
              and logs the password once, on first start. It also keeps it in{" "}
              <code>/data/initial-admin-password</code>.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
