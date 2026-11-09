import type { OtlpAnyValue, OtlpKeyValue } from "./otlp-common-types.ts";

/** The shape of an OTLP logs export request after decoding, as for traces. */
export interface OtlpExportLogsRequest {
  resourceLogs?: OtlpResourceLogs[];
}

export interface OtlpResourceLogs {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeLogs?: OtlpScopeLogs[];
}

export interface OtlpScopeLogs {
  logRecords?: OtlpLogRecord[];
}

export interface OtlpLogRecord {
  timeUnixNano?: string | number;
  observedTimeUnixNano?: string | number;
  severityNumber?: number | string;
  severityText?: string;
  body?: OtlpAnyValue;
  attributes?: OtlpKeyValue[];
  traceId?: Uint8Array | string;
  spanId?: Uint8Array | string;
}

export interface LogsExportOutcome {
  rejectedLogRecordCount: number;
  errorMessage: string | null;
}
