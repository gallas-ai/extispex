import { AlertIcon } from "./icons.tsx";

interface LoadErrorProps {
  /** What could not be loaded, for example "Traces". */
  subject: string;
  message: string;
  isSignInRequired: boolean;
  onRetry: () => void;
  onSignInRequired: () => void;
}

/** A page-level error, offering to sign in again when the browser's sign-in has ended. */
export function LoadError(
  { subject, message, isSignInRequired, onRetry, onSignInRequired }: LoadErrorProps,
) {
  return (
    <div className="empty-state empty-state-error" role="alert">
      <span className="empty-state-icon">
        <AlertIcon size={22} />
      </span>
      <h2>{isSignInRequired ? "Your sign-in has ended" : `${subject} could not be loaded`}</h2>
      <p>{message}</p>
      <div className="button-row">
        {isSignInRequired
          ? (
            <button type="button" className="button button-primary" onClick={onSignInRequired}>
              Sign in again
            </button>
          )
          : (
            <button type="button" className="button button-primary" onClick={onRetry}>
              Try again
            </button>
          )}
      </div>
    </div>
  );
}
