import * as openIdClient from "openid-client";
import type { OidcSettings } from "./oidc-settings.ts";

export interface OidcAuthorizationRequest {
  authorizationUrl: URL;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcAuthorizationChecks {
  state: string;
  nonce: string;
  codeVerifier: string;
}

/** What a verified ID token says about the user; see `OidcUserIdentity` for what is stored. */
export interface OidcClaims {
  issuer: string;
  subject: string;
  email: string | null;
  /** True only when the provider says outright that it has not verified the address. */
  isEmailUnverified: boolean;
  name: string | null;
  companyGroups: string[];
}

/** The company's identity provider. A failure of either method is an error to log. */
export interface OidcProvider {
  createAuthorizationRequest(): Promise<OidcAuthorizationRequest>;
  /** Redeems the code from the redirect's query and verifies the ID token. */
  completeAuthorization(
    responseQuery: string,
    checks: OidcAuthorizationChecks,
  ): Promise<OidcClaims>;
}

export function createOidcProvider(
  settings: OidcSettings,
  fetchFromProvider?: typeof fetch,
): OidcProvider {
  let configuration: Promise<openIdClient.Configuration> | null = null;

  // Read on first use, so that an identity provider that is down does not stop Identity starting.
  const readConfiguration = () => {
    configuration ??= openIdClient.discovery(
      new URL(settings.issuerUrl),
      settings.clientId,
      undefined,
      openIdClient.ClientSecretBasic(settings.clientSecret),
      {
        execute: settings.allowsInsecureHttp ? [openIdClient.allowInsecureRequests] : [],
        ...(fetchFromProvider === undefined
          ? {}
          : { [openIdClient.customFetch]: fetchFromProvider as openIdClient.CustomFetch }),
      },
    ).catch((error) => {
      configuration = null;
      throw error;
    });
    return configuration;
  };

  return {
    async createAuthorizationRequest() {
      const state = openIdClient.randomState();
      const nonce = openIdClient.randomNonce();
      const codeVerifier = openIdClient.randomPKCECodeVerifier();
      const authorizationUrl = openIdClient.buildAuthorizationUrl(await readConfiguration(), {
        redirect_uri: settings.redirectUrl,
        scope: settings.scopes,
        state,
        nonce,
        code_challenge: await openIdClient.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: "S256",
      });
      return { authorizationUrl, state, nonce, codeVerifier };
    },

    async completeAuthorization(responseQuery, checks) {
      const tokens = await openIdClient.authorizationCodeGrant(
        await readConfiguration(),
        // The configured address, because the library sends this URL as `redirect_uri` and the
        // Identity service does not know the address the browser used.
        new URL(`${settings.redirectUrl}${responseQuery}`),
        {
          expectedState: checks.state,
          expectedNonce: checks.nonce,
          pkceCodeVerifier: checks.codeVerifier,
          idTokenExpected: true,
        },
      );
      const claims = tokens.claims()!;
      return {
        issuer: claims.iss,
        subject: claims.sub,
        email: typeof claims.email === "string" ? claims.email : null,
        isEmailUnverified: claims.email_verified === false,
        name: typeof claims.name === "string" ? claims.name : null,
        companyGroups: readCompanyGroups(claims[settings.groupsClaim]),
      };
    },
  };
}

function readCompanyGroups(claimValue: unknown): string[] {
  const groupNames = typeof claimValue === "string"
    ? [claimValue]
    : Array.isArray(claimValue)
    ? claimValue
    : [];
  return groupNames.filter((groupName): groupName is string =>
    typeof groupName === "string" && groupName !== ""
  );
}
