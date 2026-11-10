import { z } from "zod";

/** `key=value`, which may be repeated in a query. Every filter must match. */
export const attributeFilterSchema = z.string().regex(/^[^=]+=/);

export const MAXIMUM_ATTRIBUTE_FILTERS = 10;

export const attributeFiltersSchema = z.union([
  attributeFilterSchema,
  z.array(attributeFilterSchema).max(MAXIMUM_ATTRIBUTE_FILTERS),
]);

export interface AttributeFilter {
  key: string;
  value: string;
}

/** `gen_ai.request.model=gpt-4` as a key and a value; the value may contain `=`. */
export function parseAttributeFilters(attribute: string | string[] | undefined): AttributeFilter[] {
  const attributeFilters = attribute === undefined
    ? []
    : Array.isArray(attribute)
    ? attribute
    : [attribute];
  return attributeFilters.map((attributeFilter) => {
    const separatorIndex = attributeFilter.indexOf("=");
    return {
      key: attributeFilter.slice(0, separatorIndex),
      value: attributeFilter.slice(separatorIndex + 1),
    };
  });
}
