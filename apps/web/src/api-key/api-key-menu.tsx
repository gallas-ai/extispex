import { type FormEvent, useEffect, useRef, useState } from "react";
import { KeyIcon, LogOutIcon } from "../ui/icons.tsx";

interface ApiKeyMenuProps {
  apiKey: string;
  onApiKeyChange: (apiKey: string) => void;
}

/** Shows which key is in use without revealing it, and lets the user replace or forget it. */
export function ApiKeyMenu({ apiKey, onApiKeyChange }: ApiKeyMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [draftApiKey, setDraftApiKey] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsideClick = (pointerEvent: PointerEvent) => {
      if (!menuRef.current?.contains(pointerEvent.target as Node)) setIsOpen(false);
    };
    const closeOnEscape = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === "Escape") {
        // The Traces page also closes a trace on Escape; the menu is on top, so it goes first.
        keyboardEvent.stopImmediatePropagation();
        setIsOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    globalThis.addEventListener("keydown", closeOnEscape, { capture: true });
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      globalThis.removeEventListener("keydown", closeOnEscape, { capture: true });
    };
  }, [isOpen]);

  const replaceApiKey = (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    const trimmedApiKey = draftApiKey.trim();
    if (trimmedApiKey === "") return;
    onApiKeyChange(trimmedApiKey);
    setDraftApiKey("");
    setIsOpen(false);
  };

  return (
    <div className="popover-anchor" ref={menuRef}>
      <button
        type="button"
        className="button button-ghost api-key-trigger"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        onClick={() => setIsOpen(!isOpen)}
      >
        <KeyIcon size={14} />
        <span className="api-key-masked">{maskApiKey(apiKey)}</span>
      </button>
      {isOpen && (
        <div className="popover" role="dialog" aria-label="API key">
          <div className="popover-section">
            <p className="popover-title">API key</p>
            <p className="popover-text">
              Requests use <code>{maskApiKey(apiKey)}</code>. The key decides which Project you see.
            </p>
          </div>
          <form className="popover-section popover-form" onSubmit={replaceApiKey}>
            <label htmlFor="replacement-api-key-input" className="field-label">
              Use a different key
            </label>
            <div className="inline-form">
              <input
                id="replacement-api-key-input"
                className="text-input"
                type="password"
                autoComplete="off"
                placeholder="New API key"
                autoFocus
                value={draftApiKey}
                onChange={(changeEvent) => setDraftApiKey(changeEvent.target.value)}
              />
              <button type="submit" className="button button-primary">Use key</button>
            </div>
          </form>
          <div className="popover-section">
            <button
              type="button"
              className="button button-ghost button-danger button-block-start"
              onClick={() => onApiKeyChange("")}
            >
              <LogOutIcon size={14} />
              Disconnect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Enough of the key to recognise it, never enough to reuse it. */
function maskApiKey(apiKey: string): string {
  return apiKey.length <= 4 ? "••••" : `••••${apiKey.slice(-4)}`;
}
