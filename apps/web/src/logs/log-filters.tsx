import type { LogSeverity } from "@extispex/contracts";
import { type FormEvent, useEffect, useState } from "react";
import {
  CUSTOM_LOG_TIME_RANGE,
  DEFAULT_LOG_TIME_RANGE,
  LOG_SEVERITIES,
  LOG_TIME_RANGE_PRESETS,
  type LogsUrlState,
} from "../navigation/logs-url-state.ts";
import { FilterField } from "../traces/trace-filters.tsx";
import { shortenIdentifier } from "../traces/trace-formatting.ts";
import { CloseIcon, FilterIcon, HashIcon, SearchIcon, TagIcon } from "../ui/icons.tsx";
import { formatDateTimeLocal } from "./log-formatting.ts";

interface LogFilterBarProps {
  appliedFilters: LogsUrlState;
  onApplyFilters: (filters: LogsUrlState) => void;
}

const NO_FILTERS: LogsUrlState = {
  search: "",
  minimumSeverity: "",
  serviceName: "",
  correlationId: "",
  traceId: "",
  attribute: "",
  range: DEFAULT_LOG_TIME_RANGE,
  from: "",
  to: "",
};

/** Whole-word search on top of filters; everything applies together when the form is sent. */
export function LogFilterBar({ appliedFilters, onApplyFilters }: LogFilterBarProps) {
  const [draftFilters, setDraftFilters] = useState(appliedFilters);

  // Filters also change from outside, for example through a link or by going Back.
  useEffect(() => {
    setDraftFilters(appliedFilters);
  }, [appliedFilters]);

  const applyDraftFilters = (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    onApplyFilters({
      ...draftFilters,
      search: draftFilters.search.trim(),
      serviceName: draftFilters.serviceName.trim(),
      correlationId: draftFilters.correlationId.trim(),
      attribute: draftFilters.attribute.trim(),
    });
  };

  const setDraftText = (field: keyof LogsUrlState) => (value: string) =>
    setDraftFilters({ ...draftFilters, [field]: value });
  const clearField = (field: keyof LogsUrlState) => () => {
    setDraftFilters({ ...draftFilters, [field]: "" });
    onApplyFilters({ ...appliedFilters, [field]: "" });
  };
  const hasAppliedFilters = serializeFilters(appliedFilters) !== serializeFilters(NO_FILTERS);

  return (
    <form className="filter-bar log-filter-bar" onSubmit={applyDraftFilters} role="search">
      <FilterField
        id="log-search"
        label="Search words in the message"
        icon={<SearchIcon size={14} />}
        value={draftFilters.search}
        isApplied={appliedFilters.search !== ""}
        onChange={setDraftText("search")}
        onClear={clearField("search")}
      />
      <label className="log-filter-select">
        <span className="visually-hidden">Severity</span>
        <select
          className="select-input"
          value={draftFilters.minimumSeverity}
          onChange={(changeEvent) =>
            setDraftFilters({
              ...draftFilters,
              minimumSeverity: changeEvent.target.value as LogSeverity | "",
            })}
        >
          <option value="">Any severity</option>
          {LOG_SEVERITIES.map((severity) => (
            <option key={severity} value={severity}>{severity} and above</option>
          ))}
        </select>
      </label>
      <label className="log-filter-select">
        <span className="visually-hidden">Time range</span>
        <select
          className="select-input"
          value={draftFilters.range}
          onChange={(changeEvent) =>
            setDraftFilters({ ...draftFilters, range: changeEvent.target.value })}
        >
          {LOG_TIME_RANGE_PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>{preset.label}</option>
          ))}
          <option value={CUSTOM_LOG_TIME_RANGE}>Custom range</option>
        </select>
      </label>
      {draftFilters.range === CUSTOM_LOG_TIME_RANGE && (
        <>
          <DateTimeField
            label="From"
            value={draftFilters.from}
            onChange={setDraftText("from")}
          />
          <DateTimeField label="To" value={draftFilters.to} onChange={setDraftText("to")} />
        </>
      )}
      <FilterField
        id="log-service"
        label="Service"
        icon={<FilterIcon size={14} />}
        value={draftFilters.serviceName}
        isApplied={appliedFilters.serviceName !== ""}
        onChange={setDraftText("serviceName")}
        onClear={clearField("serviceName")}
      />
      <FilterField
        id="log-correlation-id"
        label="Correlation ID"
        icon={<HashIcon size={14} />}
        value={draftFilters.correlationId}
        isApplied={appliedFilters.correlationId !== ""}
        onChange={setDraftText("correlationId")}
        onClear={clearField("correlationId")}
      />
      <FilterField
        id="log-attribute"
        label="Attribute: key=value"
        icon={<TagIcon size={14} />}
        value={draftFilters.attribute}
        isApplied={appliedFilters.attribute !== ""}
        pattern="[^=]+=.*"
        patternHint="Write the attribute as key=value."
        onChange={setDraftText("attribute")}
        onClear={clearField("attribute")}
      />
      {appliedFilters.traceId !== "" && (
        <span className="log-trace-filter">
          Trace{" "}
          <code title={appliedFilters.traceId}>{shortenIdentifier(appliedFilters.traceId)}</code>
          <button
            type="button"
            className="icon-button"
            onClick={clearField("traceId")}
            aria-label="Show logs of every trace"
            title="Show logs of every trace"
          >
            <CloseIcon size={13} />
          </button>
        </span>
      )}
      <button type="submit" className="button button-primary">
        <SearchIcon size={14} />
        Search
      </button>
      {hasAppliedFilters && (
        <button
          type="button"
          className="button button-ghost"
          onClick={() => onApplyFilters(NO_FILTERS)}
        >
          Clear filters
        </button>
      )}
    </form>
  );
}

function serializeFilters(filters: LogsUrlState): string {
  return JSON.stringify(filters);
}

function DateTimeField(
  { label, value, onChange }: { label: string; value: string; onChange: (value: string) => void },
) {
  return (
    <label className="log-filter-date">
      <span>{label}</span>
      <input
        type="datetime-local"
        className="text-input"
        value={formatDateTimeLocal(value)}
        onChange={(changeEvent) =>
          onChange(
            changeEvent.target.value === "" ? "" : new Date(changeEvent.target.value).toISOString(),
          )}
      />
    </label>
  );
}
