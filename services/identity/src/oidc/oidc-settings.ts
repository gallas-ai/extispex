import { InvalidConfigurationError } from "@extispex/service-runtime";

/** How Identity signs users in through the company's identity provider. */
export interface OidcSettings {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  /** Must be this Instance's Gateway address followed by `/v1/sign-in/oidc/callback`. */
  redirectUrl: string;
  /** Space-separated, with `openid` among them. */
  scopes: string;
  /** The claim of the ID token that lists the user's Company groups. */
  groupsClaim: string;
  /** Shown on the sign-in button. */
  providerName: string;
  /** Whether the identity provider may be reached without TLS, for local development only. */
  allowsInsecureHttp: boolean;
}

/**
 * Reads the `OIDC_*` variables; null when `OIDC_ISSUER_URL` is not set, which means no OIDC. Takes
 * the reader as an argument so that every deployment's `main` reads them the same way.
 */
export function readOidcSettings(
  readVariable: (variableName: string) => string | undefined,
): OidcSettings | null {
  const issuerUrl = readVariable("OIDC_ISSUER_URL");
  if (issuerUrl === undefined) return null;
  const readRequired = (variableName: string) => {
    const variableValue = readVariable(variableName);
    if (variableValue === undefined) {
      throw new InvalidConfigurationError(`${variableName} is required with OIDC_ISSUER_URL.`);
    }
    return variableValue;
  };
  const allowsInsecureHttp = readVariable("OIDC_ALLOW_INSECURE_HTTP") === "enabled";
  if (new URL(issuerUrl).protocol !== "https:" && !allowsInsecureHttp) {
    throw new InvalidConfigurationError(
      "OIDC_ISSUER_URL must use https. For local development, set OIDC_ALLOW_INSECURE_HTTP=enabled.",
    );
  }
  return {
    issuerUrl,
    clientId: readRequired("OIDC_CLIENT_ID"),
    clientSecret: readRequired("OIDC_CLIENT_SECRET"),
    redirectUrl: readRequired("OIDC_REDIRECT_URL"),
    scopes: readVariable("OIDC_SCOPES") ?? "openid profile email",
    groupsClaim: readVariable("OIDC_GROUPS_CLAIM") ?? "groups",
    providerName: readVariable("OIDC_PROVIDER_NAME") ?? "your company account",
    allowsInsecureHttp,
  };
}
