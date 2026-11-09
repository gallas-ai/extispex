/** OTLP's common value types after decoding, shared by every signal. */
export interface OtlpKeyValue {
  key?: string;
  value?: OtlpAnyValue;
}

export interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: OtlpAnyValue[] };
  kvlistValue?: { values?: OtlpKeyValue[] };
  bytesValue?: Uint8Array | string;
}
