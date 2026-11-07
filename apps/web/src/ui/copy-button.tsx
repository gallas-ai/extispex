import { type MouseEvent, useEffect, useState } from "react";
import { CheckIcon, CopyIcon } from "./icons.tsx";

const COPIED_FEEDBACK_MILLISECONDS = 1500;

interface CopyButtonProps {
  value: string;
  /** What is copied, for screen readers, for example "Trace ID". */
  label: string;
  className?: string;
}

export function CopyButton({ value, label, className }: CopyButtonProps) {
  const [hasCopied, setHasCopied] = useState(false);

  useEffect(() => {
    if (!hasCopied) return;
    const resetTimer = setTimeout(() => setHasCopied(false), COPIED_FEEDBACK_MILLISECONDS);
    return () => clearTimeout(resetTimer);
  }, [hasCopied]);

  const copyValue = async (clickEvent: MouseEvent) => {
    // Copying inside a clickable row must not also select the row.
    clickEvent.stopPropagation();
    if (await copyToClipboard(value)) setHasCopied(true);
  };

  return (
    <button
      type="button"
      className={`icon-button copy-button${hasCopied ? " copy-button-done" : ""}${
        className ? ` ${className}` : ""
      }`}
      onClick={copyValue}
      aria-label={hasCopied ? `${label} copied` : `Copy ${label}`}
      title={hasCopied ? "Copied" : `Copy ${label}`}
    >
      {hasCopied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
    </button>
  );
}

/** The Clipboard API needs a secure context, which a plain-HTTP instance on a LAN is not. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const fallbackField = document.createElement("textarea");
    fallbackField.value = text;
    fallbackField.setAttribute("readonly", "");
    fallbackField.style.position = "fixed";
    fallbackField.style.opacity = "0";
    document.body.append(fallbackField);
    fallbackField.select();
    const hasCopied = document.execCommand("copy");
    fallbackField.remove();
    return hasCopied;
  }
}
