/** Signing in through the Gateway, as the web UI does, for tests that call the REST API. */
import { assertEquals } from "@std/assert";
import type {
  AccessTokenResponse,
  CreateUserRequest,
  Group,
  Role,
  User,
} from "@extispex/contracts";
import type { LocalAccount, RunningDeployment } from "./deployment.ts";

export interface SignedInUser {
  user: User;
  /** A token without a Project, for managing access. */
  accessToken: string;
  /** A token for the Project; rejects when the user has no Role there. */
  requestProjectToken(projectId: string): Promise<AccessTokenResponse>;
}

export async function signInThroughGateway(
  deployment: RunningDeployment,
  account: LocalAccount,
): Promise<SignedInUser> {
  const signInResponse = await fetch(`${deployment.gatewayUrl}/v1/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(account),
  });
  const user = await signInResponse.json() as User;
  assertEquals(signInResponse.status, 200, JSON.stringify(user));
  const cookie = signInResponse.headers.get("set-cookie")!.split(";")[0];
  const requestToken = async (projectId?: string) => {
    const response = await fetch(`${deployment.gatewayUrl}/v1/sign-in/access-tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(projectId === undefined ? {} : { projectId }),
    });
    const responseBody = await response.json();
    if (!response.ok) {
      throw new Error(
        `No token for ${projectId}: ${response.status} ${JSON.stringify(responseBody)}`,
      );
    }
    return responseBody as AccessTokenResponse;
  };
  return {
    user,
    accessToken: (await requestToken()).accessToken,
    requestProjectToken: requestToken,
  };
}

/** Sends a request through the Gateway and checks its status; resolves to the JSON body. */
export async function callGateway<ResponseBody>(
  deployment: RunningDeployment,
  method: string,
  path: string,
  expectedStatus: number,
  { bearerToken, body }: { bearerToken: string; body?: unknown },
): Promise<ResponseBody> {
  const headers = new Headers({ authorization: `Bearer ${bearerToken}` });
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${deployment.gatewayUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const responseText = await response.text();
  assertEquals(response.status, expectedStatus, `${method} ${path}: ${responseText}`);
  return (responseText === "" ? null : JSON.parse(responseText)) as ResponseBody;
}

/**
 * Creates a local account in a Group of its own with the Role in the Project, and signs it in.
 * Names carry a random part, so that runs against a shared database do not collide.
 */
export async function createUserWithRole(
  deployment: RunningDeployment,
  admin: SignedInUser,
  projectId: string,
  role: Role,
): Promise<{ account: LocalAccount; signedIn: SignedInUser; group: Group }> {
  const uniquePart = crypto.randomUUID().slice(0, 8);
  const account = { email: `${role}-${uniquePart}@e2e.extispex.test`, password: "e2e-password-1" };
  const userRequest: CreateUserRequest = {
    email: account.email,
    displayName: `${role} ${uniquePart}`,
    password: account.password,
  };
  const user = await callGateway<User>(deployment, "POST", "/v1/users", 201, {
    bearerToken: admin.accessToken,
    body: userRequest,
  });
  const group = await callGateway<Group>(deployment, "POST", "/v1/groups", 201, {
    bearerToken: admin.accessToken,
    body: { name: `e2e ${role}s ${uniquePart}` },
  });
  await callGateway(deployment, "PUT", `/v1/groups/${group.id}/members/${user.id}`, 200, {
    bearerToken: admin.accessToken,
  });
  await callGateway(
    deployment,
    "PUT",
    `/v1/projects/${projectId}/role-assignments/${group.id}`,
    200,
    { bearerToken: admin.accessToken, body: { role } },
  );
  return { account, signedIn: await signInThroughGateway(deployment, account), group };
}
