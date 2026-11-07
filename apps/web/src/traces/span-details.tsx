import type { Span } from "@extispex/contracts";
import { useState } from "react";
import { CopyButton } from "../ui/copy-button.tsx";
import { AlertIcon, SearchIcon } from "../ui/icons.tsx";
import { summarizeGenAiSpan } from "./gen-ai-attributes.ts";
import {
  formatAttributeValue,
  formatDuration,
  formatStructuredAttributeValue,
  millisecondsBetween,
} from "./trace-formatting.ts";

/** Above this many attributes a search field helps find one. */
const ATTRIBUTE_SEARCH_THRESHOLD = 8;

interface SpanDetailsProps {
  span: Span;
  traceStartUnixNanoseconds: string;
}

export function SpanDetails({ span, traceStartUnixNanoseconds }: SpanDetailsProps) {
  const genAiSummary = summarizeGenAiSpan(span.attributes);
  const startOffsetMilliseconds = millisecondsBetween(
    traceStartUnixNanoseconds,
    span.startTimeUnixNano,
  );

  return (
    <section className="span-details" aria-label={`Span ${span.name}`}>
      <header className="span-details-header">
        <span className={`kind-dot kind-${span.kind}`} aria-hidden="true" />
        <h3>{span.name}</h3>
        <StatusBadge statusCode={span.statusCode} />
      </header>

      {span.statusCode === "error" && span.statusMessage && (
        <div className="callout callout-danger">
          <AlertIcon size={16} />
          <p>{span.statusMessage}</p>
        </div>
      )}

      <dl className="property-grid">
        <Property label="Duration" value={formatDuration(span.durationMilliseconds)} />
        <Property
          label="Starts at"
          value={startOffsetMilliseconds === 0
            ? "Trace start"
            : `+${formatDuration(startOffsetMilliseconds)}`}
        />
        <Property label="Kind" value={span.kind} />
        {span.serviceName && <Property label="Service" value={span.serviceName} />}
        {genAiSummary.model !== null && <Property label="Model" value={genAiSummary.model} />}
        {genAiSummary.toolName !== null && <Property label="Tool" value={genAiSummary.toolName} />}
        {genAiSummary.inputTokens !== null && (
          <Property label="Input tokens" value={genAiSummary.inputTokens.toLocaleString()} />
        )}
        {genAiSummary.outputTokens !== null && (
          <Property label="Output tokens" value={genAiSummary.outputTokens.toLocaleString()} />
        )}
        <Property label="Span ID" value={span.spanId} isIdentifier />
        <Property label="Parent span ID" value={span.parentSpanId ?? "—"} isIdentifier />
      </dl>

      <AttributeSection title="Attributes" attributes={span.attributes} isInitiallyOpen />
      <AttributeSection
        title="Resource"
        attributes={span.resourceAttributes}
        isInitiallyOpen={false}
      />
    </section>
  );
}

function StatusBadge({ statusCode }: { statusCode: Span["statusCode"] }) {
  const label = { ok: "OK", error: "Error", unset: "Unset" }[statusCode];
  return (
    <span className={`status-badge status-badge-${statusCode}`} title="Span status">
      {label}
    </span>
  );
}

function Property(
  { label, value, isIdentifier = false }: {
    label: string;
    value: string;
    isIdentifier?: boolean;
  },
) {
  return (
    <div className="property">
      <dt>{label}</dt>
      <dd>
        {isIdentifier
          ? (
            <span className="identifier-with-actions">
              <code>{value}</code>
              {value !== "—" && <CopyButton value={value} label={label} />}
            </span>
          )
          : value}
      </dd>
    </div>
  );
}

interface AttributeSectionProps {
  title: string;
  attributes: Record<string, unknown>;
  isInitiallyOpen: boolean;
}

function AttributeSection({ title, attributes, isInitiallyOpen }: AttributeSectionProps) {
  const [searchText, setSearchText] = useState("");
  const allEntries = Object.entries(attributes).sort(([firstKey], [secondKey]) =>
    firstKey.localeCompare(secondKey)
  );
  const normalizedSearchText = searchText.trim().toLowerCase();
  const visibleEntries = normalizedSearchText === "" ? allEntries : allEntries.filter((
    [attributeKey, attributeValue],
  ) =>
    attributeKey.toLowerCase().includes(normalizedSearchText) ||
    formatAttributeValue(attributeValue).toLowerCase().includes(normalizedSearchText)
  );

  return (
    <details className="attribute-section" open={isInitiallyOpen}>
      <summary>
        <span className="attribute-section-title">{title}</span>
        <span className="count-badge">{allEntries.length}</span>
      </summary>
      {allEntries.length === 0 ? <p className="text-subtle attribute-empty">None</p> : (
        <>
          {allEntries.length > ATTRIBUTE_SEARCH_THRESHOLD && (
            <div className="attribute-search">
              <SearchIcon size={13} />
              <input
                className="attribute-search-input"
                placeholder={`Search ${title.toLowerCase()}`}
                aria-label={`Search ${title.toLowerCase()}`}
                value={searchText}
                onChange={(changeEvent) => setSearchText(changeEvent.target.value)}
              />
            </div>
          )}
          <dl className="attribute-list">
            {visibleEntries.map(([attributeKey, attributeValue]) => (
              <AttributeRow
                key={attributeKey}
                attributeKey={attributeKey}
                attributeValue={attributeValue}
              />
            ))}
            {visibleEntries.length === 0 && (
              <p className="text-subtle attribute-empty">Nothing matches “{searchText}”.</p>
            )}
          </dl>
        </>
      )}
    </details>
  );
}

function AttributeRow(
  { attributeKey, attributeValue }: { attributeKey: string; attributeValue: unknown },
) {
  const structuredValue = formatStructuredAttributeValue(attributeValue);
  const plainValue = formatAttributeValue(attributeValue);
  return (
    <div className="attribute-row">
      <dt title={attributeKey}>{attributeKey}</dt>
      <dd>
        {structuredValue === null
          ? <span className={valueClassName(attributeValue)}>{plainValue}</span>
          : <pre className="attribute-json">{structuredValue}</pre>}
      </dd>
      <CopyButton value={plainValue} label={attributeKey} className="attribute-copy" />
    </div>
  );
}

function valueClassName(attributeValue: unknown): string {
  if (typeof attributeValue === "number") return "value-number";
  if (typeof attributeValue === "boolean") return "value-boolean";
  return "value-string";
}
