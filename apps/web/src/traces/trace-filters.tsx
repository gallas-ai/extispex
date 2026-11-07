import { type FormEvent, type ReactNode, type RefObject, useEffect, useState } from "react";
import type { TraceFilters } from "../api/telemetry-api.ts";
import { CloseIcon, HashIcon, SearchIcon, SessionIcon } from "../ui/icons.tsx";

interface TraceFilterBarProps {
  appliedFilters: TraceFilters;
  onApplyFilters: (filters: TraceFilters) => void;
  correlationIdInputRef: RefObject<HTMLInputElement | null>;
}

export function TraceFilterBar(
  { appliedFilters, onApplyFilters, correlationIdInputRef }: TraceFilterBarProps,
) {
  const [draftFilters, setDraftFilters] = useState(appliedFilters);

  // Filters also change from outside, for example by clicking a Session ID or going Back.
  useEffect(() => {
    setDraftFilters(appliedFilters);
  }, [appliedFilters.correlationId, appliedFilters.sessionId]);

  const applyDraftFilters = (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    onApplyFilters({
      correlationId: draftFilters.correlationId.trim(),
      sessionId: draftFilters.sessionId.trim(),
    });
  };

  const clearFilter = (field: keyof TraceFilters) => {
    const nextFilters = { ...draftFilters, [field]: "" };
    setDraftFilters(nextFilters);
    onApplyFilters({ ...appliedFilters, [field]: "" });
  };

  const hasDraftChanges = draftFilters.correlationId.trim() !== appliedFilters.correlationId ||
    draftFilters.sessionId.trim() !== appliedFilters.sessionId;
  const hasAppliedFilters = appliedFilters.correlationId !== "" || appliedFilters.sessionId !== "";

  return (
    <form className="filter-bar" onSubmit={applyDraftFilters} role="search">
      <FilterField
        id="correlation-id-filter"
        label="Correlation ID"
        icon={<HashIcon size={14} />}
        value={draftFilters.correlationId}
        isApplied={appliedFilters.correlationId !== ""}
        inputRef={correlationIdInputRef}
        shortcutHint="/"
        onChange={(correlationId) => setDraftFilters({ ...draftFilters, correlationId })}
        onClear={() => clearFilter("correlationId")}
      />
      <FilterField
        id="session-id-filter"
        label="Session ID"
        icon={<SessionIcon size={14} />}
        value={draftFilters.sessionId}
        isApplied={appliedFilters.sessionId !== ""}
        onChange={(sessionId) => setDraftFilters({ ...draftFilters, sessionId })}
        onClear={() => clearFilter("sessionId")}
      />
      <button
        type="submit"
        className={`button ${hasDraftChanges ? "button-primary" : "button-secondary"}`}
      >
        <SearchIcon size={14} />
        Search
      </button>
      {hasAppliedFilters && (
        <button
          type="button"
          className="button button-ghost"
          onClick={() => onApplyFilters({ correlationId: "", sessionId: "" })}
        >
          Clear filters
        </button>
      )}
    </form>
  );
}

interface FilterFieldProps {
  id: string;
  label: string;
  icon: ReactNode;
  value: string;
  isApplied: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
  shortcutHint?: string;
  onChange: (value: string) => void;
  onClear: () => void;
}

function FilterField(
  { id, label, icon, value, isApplied, inputRef, shortcutHint, onChange, onClear }:
    FilterFieldProps,
) {
  return (
    <div className={`filter-field${isApplied ? " filter-field-applied" : ""}`}>
      <label htmlFor={id} className="filter-field-label">
        {icon}
        <span className="visually-hidden">{label}</span>
      </label>
      <input
        id={id}
        ref={inputRef}
        className="filter-field-input"
        placeholder={label}
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(changeEvent) => onChange(changeEvent.target.value)}
      />
      {value !== ""
        ? (
          <button
            type="button"
            className="icon-button filter-field-clear"
            onClick={onClear}
            aria-label={`Clear ${label}`}
            title={`Clear ${label}`}
          >
            <CloseIcon size={13} />
          </button>
        )
        : shortcutHint && <kbd className="filter-field-shortcut">{shortcutHint}</kbd>}
    </div>
  );
}
