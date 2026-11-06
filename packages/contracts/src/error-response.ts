import { z } from "zod";

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export function createErrorResponse(code: string, message: string): ErrorResponse {
  return { error: { code, message } };
}
