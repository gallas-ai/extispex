import {
  activateSigningKeyRoute,
  addSigningKeyRoute,
  createErrorResponse,
  listSigningKeysRoute,
  retireSigningKeyRoute,
} from "@extispex/contracts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { type IdentityEnvironment, INSTANCE_ADMIN_REQUIRED } from "../access/mod.ts";
import type { AccessTokenSigner } from "./signing-keys.ts";

/** Rotating the key that signs access tokens. Every endpoint takes an Instance admin. */
export function registerSigningKeyRoutes(
  app: OpenAPIHono<IdentityEnvironment>,
  { accessTokenSigner }: { accessTokenSigner: AccessTokenSigner },
): void {
  const notFound = (keyId: string) =>
    createErrorResponse("not_found", `Signing key ${keyId} was not found.`);

  app.openapi(listSigningKeysRoute, async (context) => {
    if (!context.get("currentUser").isInstanceAdmin) {
      return context.json(INSTANCE_ADMIN_REQUIRED, 403);
    }
    return context.json({ keys: await accessTokenSigner.listSigningKeys() }, 200);
  });

  app.openapi(addSigningKeyRoute, async (context) => {
    if (!context.get("currentUser").isInstanceAdmin) {
      return context.json(INSTANCE_ADMIN_REQUIRED, 403);
    }
    return context.json(await accessTokenSigner.addSigningKey(), 201);
  });

  app.openapi(activateSigningKeyRoute, async (context) => {
    if (!context.get("currentUser").isInstanceAdmin) {
      return context.json(INSTANCE_ADMIN_REQUIRED, 403);
    }
    const { keyId } = context.req.valid("param");
    const result = await accessTokenSigner.activateSigningKey(keyId);
    switch (result.status) {
      case "activated":
        return context.json(result.key, 200);
      case "not_found":
        return context.json(notFound(keyId), 404);
      case "retired":
        return context.json(
          createErrorResponse("key_retired", "A retired key cannot sign again; add a new one."),
          409,
        );
      case "too_new":
        return context.json(
          createErrorResponse(
            "key_too_new",
            `Services may not know this key yet. It can sign from ${result.canSignFrom}.`,
          ),
          409,
        );
    }
  });

  app.openapi(retireSigningKeyRoute, async (context) => {
    if (!context.get("currentUser").isInstanceAdmin) {
      return context.json(INSTANCE_ADMIN_REQUIRED, 403);
    }
    const { keyId } = context.req.valid("param");
    const result = await accessTokenSigner.retireSigningKey(keyId);
    switch (result.status) {
      case "retired":
        return context.json(result.key, 200);
      case "not_found":
        return context.json(notFound(keyId), 404);
      case "signing":
        return context.json(
          createErrorResponse(
            "key_signing",
            "This key signs access tokens. Activate another key first, which retires this one.",
          ),
          409,
        );
    }
  });
}
