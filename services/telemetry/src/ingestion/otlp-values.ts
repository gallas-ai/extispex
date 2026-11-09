import type { OtlpAnyValue, OtlpKeyValue } from "./otlp-common-types.ts";

export const TRACE_ID_HEX_LENGTH = 32;
export const SPAN_ID_HEX_LENGTH = 16;

/** Returns lowercase hex, or null for a missing, malformed or all-zero ID. */
export function convertIdToHex(
  idValue: Uint8Array | string | undefined,
  expectedHexLength: number,
): string | null {
  if (idValue === undefined) {
    return null;
  }
  const hexId = typeof idValue === "string"
    ? idValue.toLowerCase()
    : Array.from(idValue, (byteValue) => byteValue.toString(16).padStart(2, "0")).join("");
  const isWellFormed = hexId.length === expectedHexLength && /^[0-9a-f]+$/.test(hexId);
  const isAllZeros = /^0+$/.test(hexId);
  return isWellFormed && !isAllZeros ? hexId : null;
}

export function parseUnixNanoseconds(timeValue: string | number | undefined): bigint | null {
  if (timeValue === undefined) {
    return null;
  }
  const timeText = String(timeValue);
  return /^\d+$/.test(timeText) ? BigInt(timeText) : null;
}

/** OTLP/JSON should send enums as numbers, but some senders use names such as `SPAN_KIND_SERVER`. */
export function convertEnumValue<EnumValue extends string>(
  rawValue: number | string | undefined,
  valuesByNumber: Record<number, EnumValue>,
  namePrefix: string,
  defaultValue: EnumValue,
): EnumValue {
  if (typeof rawValue === "number") {
    return valuesByNumber[rawValue] ?? defaultValue;
  }
  if (typeof rawValue === "string") {
    const valueName = rawValue.replace(namePrefix, "").toLowerCase();
    const knownValue = Object.values(valuesByNumber).find((enumValue) => enumValue === valueName);
    return knownValue ?? defaultValue;
  }
  return defaultValue;
}

export function convertKeyValues(keyValues: OtlpKeyValue[] | undefined): Record<string, unknown> {
  const convertedAttributes: Record<string, unknown> = {};
  for (const keyValue of keyValues ?? []) {
    if (keyValue.key) {
      convertedAttributes[keyValue.key] = convertAnyValue(keyValue.value);
    }
  }
  return convertedAttributes;
}

export function convertAnyValue(anyValue: OtlpAnyValue | undefined): unknown {
  if (anyValue === undefined) {
    return null;
  }
  if (anyValue.stringValue !== undefined) return anyValue.stringValue;
  if (anyValue.boolValue !== undefined) return anyValue.boolValue;
  if (anyValue.doubleValue !== undefined) return anyValue.doubleValue;
  if (anyValue.intValue !== undefined) {
    const integerValue = Number(anyValue.intValue);
    return Number.isSafeInteger(integerValue) ? integerValue : String(anyValue.intValue);
  }
  if (anyValue.arrayValue !== undefined) {
    return (anyValue.arrayValue.values ?? []).map(convertAnyValue);
  }
  if (anyValue.kvlistValue !== undefined) {
    return convertKeyValues(anyValue.kvlistValue.values);
  }
  if (anyValue.bytesValue !== undefined) {
    return typeof anyValue.bytesValue === "string"
      ? anyValue.bytesValue
      : btoa(String.fromCharCode(...anyValue.bytesValue));
  }
  return null;
}
