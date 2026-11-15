import { z } from "zod";

/**
 * Where a key that signs access tokens stands: `signing` signs every new token; `published` is in
 * the JWKS so that services know it before it signs; `retired` was replaced and stays published
 * until every token it signed has expired, then it is removed.
 */
export const SIGNING_KEY_STATES = ["signing", "published", "retired"] as const;
export const signingKeyStateSchema = z.enum(SIGNING_KEY_STATES);
export type SigningKeyState = z.infer<typeof signingKeyStateSchema>;

export const signingKeySchema = z.object({
  /** The `kid` in the access tokens it signs. */
  keyId: z.string(),
  state: signingKeyStateSchema,
  createdAt: z.string(),
  activatedAt: z.string().nullable(),
  retiredAt: z.string().nullable(),
  /** From when it may sign: once services had time to read it from the JWKS endpoint. */
  canSignFrom: z.string(),
  /** When a retired key is removed, after the longest token lifetime. */
  removedAt: z.string().nullable(),
});
export type SigningKey = z.infer<typeof signingKeySchema>;

export const listSigningKeysResponseSchema = z.object({ keys: z.array(signingKeySchema) });
export type ListSigningKeysResponse = z.infer<typeof listSigningKeysResponseSchema>;
