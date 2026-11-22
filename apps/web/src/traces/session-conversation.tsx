import type { SessionConversationResponse, SessionConversationTrace } from "@extispex/contracts";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertIcon, WrenchIcon } from "../ui/icons.tsx";
import { useNow } from "../ui/use-now.ts";
import {
  formatDuration,
  formatRelativeTime,
  formatUnixNanoseconds,
  unixNanosecondsToMilliseconds,
} from "./trace-formatting.ts";

const RELATIVE_TIME_REFRESH_MILLISECONDS = 15_000;

interface SessionConversationProps {
  conversation: SessionConversationResponse;
  selectedTraceId: string | null;
  /** Traces with this Correlation ID stand out; empty for none. */
  highlightedCorrelationId: string;
  onSelectTrace: (traceId: string) => void;
  onShowTable: () => void;
}

/** A Session as the conversation it was: each trace's messages, oldest first. */
export function SessionConversation(
  { conversation, selectedTraceId, highlightedCorrelationId, onSelectTrace, onShowTable }:
    SessionConversationProps,
) {
  const nowUnixMilliseconds = useNow(RELATIVE_TIME_REFRESH_MILLISECONDS);
  const listRef = useRef<HTMLOListElement>(null);

  // Keyboard selection elsewhere (j and k) should keep the selected trace in view.
  useEffect(() => {
    listRef.current?.querySelector(".conversation-trace-selected")?.scrollIntoView({
      block: "nearest",
    });
  }, [selectedTraceId]);

  return (
    <div className="session-conversation">
      <ConversationSummary conversation={conversation} />
      {conversation.truncated && (
        <div className="callout callout-warning conversation-truncated">
          <AlertIcon size={14} />
          <p>
            Showing the first {conversation.traces.length} traces of this Session.{" "}
            <button type="button" className="link-button" onClick={onShowTable}>
              The table
            </button>{" "}
            lists the newest ones.
          </p>
        </div>
      )}
      <ol className="conversation-traces" ref={listRef} aria-label="Conversation">
        {conversation.traces.map((trace) => (
          <ConversationTrace
            key={trace.traceId}
            trace={trace}
            isSelected={trace.traceId === selectedTraceId}
            isHighlighted={highlightedCorrelationId !== "" &&
              trace.correlationId === highlightedCorrelationId}
            nowUnixMilliseconds={nowUnixMilliseconds}
            onSelectTrace={onSelectTrace}
          />
        ))}
      </ol>
    </div>
  );
}

function ConversationSummary({ conversation }: { conversation: SessionConversationResponse }) {
  const { summary } = conversation;
  return (
    <dl className="stat-row conversation-summary">
      <SummaryStat label="Traces" value={String(summary.traceCount)} />
      <SummaryStat label="Duration" value={formatDuration(summary.durationMilliseconds)} />
      <SummaryStat label="Tokens" value={formatTokens(summary.inputTokens, summary.outputTokens)} />
      <SummaryStat
        label="Traces with errors"
        value={String(summary.tracesWithErrors)}
        isDanger={summary.tracesWithErrors > 0}
      />
      <SummaryStat label="Started" value={formatUnixNanoseconds(summary.firstStartTimeUnixNano)} />
    </dl>
  );
}

function SummaryStat(
  { label, value, isDanger = false }: { label: string; value: string; isDanger?: boolean },
) {
  return (
    <div className={`stat${isDanger ? " stat-danger" : ""}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

interface ConversationTraceProps {
  trace: SessionConversationTrace;
  isSelected: boolean;
  isHighlighted: boolean;
  nowUnixMilliseconds: number;
  onSelectTrace: (traceId: string) => void;
}

function ConversationTrace(
  { trace, isSelected, isHighlighted, nowUnixMilliseconds, onSelectTrace }: ConversationTraceProps,
) {
  const startUnixMilliseconds = unixNanosecondsToMilliseconds(trace.startTimeUnixNano);
  const hasMessages = trace.userMessage !== null || trace.assistantMessage !== null;
  const classNames = [
    "conversation-trace",
    isSelected ? "conversation-trace-selected" : "",
    isHighlighted ? "conversation-trace-highlighted" : "",
    trace.errorSpanCount > 0 ? "conversation-trace-failed" : "",
  ].filter(Boolean).join(" ");

  return (
    <li
      className={classNames}
      data-trace-id={trace.traceId}
      tabIndex={0}
      aria-current={isSelected ? "true" : undefined}
      aria-label={`Trace ${trace.rootSpanName ?? trace.traceId}`}
      onClick={(clickEvent) => {
        // Selecting text in a message should not open the trace.
        if (globalThis.getSelection()?.toString()) return;
        if ((clickEvent.target as HTMLElement).closest("button")) return;
        onSelectTrace(trace.traceId);
      }}
      onKeyDown={(keyboardEvent: KeyboardEvent<HTMLLIElement>) => {
        if (keyboardEvent.target !== keyboardEvent.currentTarget) return;
        if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
          keyboardEvent.preventDefault();
          onSelectTrace(trace.traceId);
        }
      }}
    >
      {trace.userMessage !== null && <ConversationMessage role="user" text={trace.userMessage} />}
      {trace.assistantMessage !== null && (
        <ConversationMessage role="assistant" text={trace.assistantMessage} />
      )}
      {!hasMessages && (
        <p className="conversation-no-messages text-subtle">
          No messages. Send <code>gen_ai.input.messages</code> and{" "}
          <code>gen_ai.output.messages</code> on the root span to see them here.
        </p>
      )}
      {trace.toolNames.length > 0 && (
        <ul className="conversation-tools" aria-label="Tools called">
          {trace.toolNames.map((toolName, toolIndex) => (
            <li key={`${toolIndex}-${toolName}`} className="span-badge span-badge-tool">
              <WrenchIcon size={11} />
              {toolName}
            </li>
          ))}
        </ul>
      )}
      {trace.firstErrorMessage !== null && (
        <p className="conversation-error">
          <AlertIcon size={13} />
          <span>{trace.firstErrorMessage}</span>
        </p>
      )}
      <p className="conversation-trace-meta">
        <span className="conversation-trace-name">
          {trace.rootSpanName ?? "Root span not received"}
        </span>
        <span>{trace.spanCount === 1 ? "1 span" : `${trace.spanCount} spans`}</span>
        <span>{formatDuration(trace.durationMilliseconds)}</span>
        {(trace.inputTokens !== null || trace.outputTokens !== null) && (
          <span>{formatTokens(trace.inputTokens, trace.outputTokens)} tokens</span>
        )}
        {trace.errorSpanCount > 0 && (
          <span className="conversation-trace-errors">
            {trace.errorSpanCount === 1 ? "1 error" : `${trace.errorSpanCount} errors`}
          </span>
        )}
        <time
          dateTime={new Date(startUnixMilliseconds).toISOString()}
          title={formatUnixNanoseconds(trace.startTimeUnixNano)}
        >
          {formatRelativeTime(startUnixMilliseconds, nowUnixMilliseconds)}
        </time>
      </p>
    </li>
  );
}

/** A message as plain text, folded to a few lines until the user asks for the rest. */
function ConversationMessage({ role, text }: { role: "user" | "assistant"; text: string }) {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isFolded, setIsFolded] = useState(false);

  useLayoutEffect(() => {
    const textElement = textRef.current;
    if (textElement === null || isExpanded) return;
    const measureFold = () => setIsFolded(textElement.scrollHeight > textElement.clientHeight + 1);
    measureFold();
    const resizeObserver = new ResizeObserver(measureFold);
    resizeObserver.observe(textElement);
    return () => resizeObserver.disconnect();
  }, [text, isExpanded]);

  return (
    <div className={`conversation-message conversation-message-${role}`}>
      <span className="conversation-message-role">{role === "user" ? "User" : "Assistant"}</span>
      <p
        ref={textRef}
        className={`conversation-message-text${isExpanded ? "" : " conversation-message-folded"}`}
      >
        {text}
      </p>
      {(isFolded || isExpanded) && (
        <button
          type="button"
          className="link-button conversation-message-toggle"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function formatTokens(inputTokens: number | null, outputTokens: number | null): string {
  if (inputTokens === null && outputTokens === null) return "—";
  const formatCount = (count: number | null) => count === null ? "—" : count.toLocaleString("en");
  return `${formatCount(inputTokens)} in · ${formatCount(outputTokens)} out`;
}
