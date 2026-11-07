import { AlertIcon } from "./icons.tsx";

interface LoadErrorProps {
  /** What could not be loaded, for example "Traces". */
  subject: string;
  message: string;
  isApiKeyRejected: boolean;
  onRetry: () => void;
  onDisconnect: () => void;
}

/** A page-level error, offering another API key when the current one was refused. */
export function LoadError(
  { subject, message, isApiKeyRejected, onRetry, onDisconnect }: LoadErrorProps,
) {
  return (
    <div className="empty-state empty-state-error" role="alert">
      <span className="empty-state-icon">
        <AlertIcon size={22} />
      </span>
      <h2>
        {isApiKeyRejected ? "The API key was not accepted" : `${subject} could not be loaded`}
      </h2>
      <p>{message}</p>
      <div className="button-row">
        {isApiKeyRejected
          ? (
            <button type="button" className="button button-primary" onClick={onDisconnect}>
              Use a different key
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
