import { type RefObject, useEffect, useRef, useState } from "react";

/** Open state for a popover that closes on a click outside its anchor and on Escape. */
export function usePopover(): {
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
  anchorRef: RefObject<HTMLDivElement | null>;
} {
  const [isOpen, setIsOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsideClick = (pointerEvent: PointerEvent) => {
      if (!anchorRef.current?.contains(pointerEvent.target as Node)) setIsOpen(false);
    };
    const closeOnEscape = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === "Escape") {
        // The Traces page also closes a trace on Escape; the popover is on top, so it goes first.
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

  return { isOpen, setIsOpen, anchorRef };
}
