/**
 * Users, Groups, Roles and tokens through the Gateway: a `viewer` reads but does not change data,
 * an `editor` changes it, an `admin` manages Roles, and a service token reads another service's
 * data for one Project.
 */
import { assert, assertEquals } from "@std/assert";
import type {
  AccessTokenResponse,
  ListPromptsResponse,
  ListRoleAssignmentsResponse,
  Project,
} from "@extispex/contracts";
import { startDeployment } from "./deployment.ts";
import { callGateway, createUserWithRole, signInThroughGateway } from "./sign-in.ts";

Deno.test("Users, Groups, Roles and tokens through the gateway", async (testContext) => {
  const deployment = await startDeployment();
  const uniquePart = crypto.randomUUID().slice(0, 8);
  try {
    const admin = await signInThroughGateway(deployment, deployment.admin);
    const project = await callGateway<Project>(deployment, "POST", "/v1/projects", 201, {
      bearerToken: admin.accessToken,
      body: { name: `e2e-access-${uniquePart}` },
    });
    const viewer = await createUserWithRole(deployment, admin, project.id, "viewer");
    const editor = await createUserWithRole(deployment, admin, project.id, "editor");
    const projectAdmin = await createUserWithRole(deployment, admin, project.id, "admin");
    const promptName = `e2e-access-${uniquePart}`;

    await testContext.step("gives each user a token with their Role in the Project", async () => {
      for (
        const [signedIn, expectedRole] of [
          [viewer.signedIn, "viewer"],
          [editor.signedIn, "editor"],
          [projectAdmin.signedIn, "admin"],
        ] as const
      ) {
        const { role } = await signedIn.requestProjectToken(project.id);
        assertEquals(role, expectedRole);
      }
    });

    await testContext.step(
      "lets an editor change prompts and a viewer only read them",
      async () => {
        const editorToken = (await editor.signedIn.requestProjectToken(project.id)).accessToken;
        const viewerToken = (await viewer.signedIn.requestProjectToken(project.id)).accessToken;
        await callGateway(deployment, "POST", "/v1/prompts", 201, {
          bearerToken: editorToken,
          body: { name: promptName, type: "text", text: "Hello {{name}}" },
        });
        const { prompts } = await callGateway<ListPromptsResponse>(
          deployment,
          "GET",
          "/v1/prompts",
          200,
          { bearerToken: viewerToken },
        );
        assertEquals(prompts.map((prompt) => prompt.name), [promptName]);
        await callGateway(deployment, "GET", "/v1/traces", 200, { bearerToken: viewerToken });
        await callGateway(deployment, "POST", `/v1/prompts/${promptName}/versions`, 403, {
          bearerToken: viewerToken,
          body: { type: "text", text: "Changed by a viewer" },
        });
        await callGateway(deployment, "PUT", `/v1/prompts/${promptName}/labels/production`, 403, {
          bearerToken: viewerToken,
          body: { versionNumber: 1 },
        });
        // Telemetry refuses spans from a viewer too.
        const otlpResponse = await fetch(`${deployment.otlpHttpUrl}/v1/traces`, {
          method: "POST",
          headers: { authorization: `Bearer ${viewerToken}`, "content-type": "application/json" },
          body: JSON.stringify({ resourceSpans: [] }),
        });
        assertEquals(otlpResponse.status, 403);
        await otlpResponse.body?.cancel();
      },
    );

    await testContext.step("keeps a token to its own Project", async () => {
      const editorToken = (await editor.signedIn.requestProjectToken(project.id)).accessToken;
      // The first Project has the prompts of other tests, never this one.
      await callGateway(deployment, "GET", `/v1/prompts/${promptName}`, 404, {
        bearerToken: deployment.apiKey,
      });
      await callGateway(deployment, "GET", `/v1/prompts/${promptName}`, 200, {
        bearerToken: editorToken,
      });
      // A token without a Project reaches no Project's data.
      await callGateway(deployment, "GET", "/v1/prompts", 401, {
        bearerToken: editor.signedIn.accessToken,
      });
    });

    await testContext.step("lets an admin manage Roles, not an editor", async () => {
      await callGateway(
        deployment,
        "PUT",
        `/v1/projects/${project.id}/role-assignments/${viewer.group.id}`,
        403,
        { bearerToken: editor.signedIn.accessToken, body: { role: "admin" } },
      );
      await callGateway(deployment, "GET", "/v1/users", 403, {
        bearerToken: projectAdmin.signedIn.accessToken,
      });
      await callGateway(
        deployment,
        "PUT",
        `/v1/projects/${project.id}/role-assignments/${viewer.group.id}`,
        200,
        { bearerToken: projectAdmin.signedIn.accessToken, body: { role: "editor" } },
      );
      const { roleAssignments } = await callGateway<ListRoleAssignmentsResponse>(
        deployment,
        "GET",
        `/v1/projects/${project.id}/role-assignments`,
        200,
        { bearerToken: projectAdmin.signedIn.accessToken },
      );
      assertEquals(
        roleAssignments.find((assignment) => assignment.groupId === viewer.group.id)?.role,
        "editor",
      );
      assertEquals((await viewer.signedIn.requestProjectToken(project.id)).role, "editor");

      await callGateway(
        deployment,
        "DELETE",
        `/v1/projects/${project.id}/role-assignments/${viewer.group.id}`,
        204,
        { bearerToken: projectAdmin.signedIn.accessToken },
      );
      let tokenError: Error | null = null;
      await viewer.signedIn.requestProjectToken(project.id).catch((error) => tokenError = error);
      assert(tokenError !== null, "A user without a Role gets no token for the Project.");
    });

    const internalAccess = deployment.identityInternalAccess;
    await testContext.step({
      name: "lets a service token read another service's data for one Project",
      ignore: internalAccess === null,
      fn: async () => {
        assert(internalAccess !== null);
        const requestServiceToken = async (body: unknown) =>
          await fetch(`${internalAccess.identityUrl}/internal/v1/service-tokens`, {
            method: "POST",
            headers: {
              authorization: `Basic ${
                btoa(`${internalAccess.clientId}:${internalAccess.clientSecret}`)
              }`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          });
        const tokenResponse = await requestServiceToken({ projectId: project.id });
        const serviceToken = await tokenResponse.json() as AccessTokenResponse;
        assertEquals(tokenResponse.status, 200, JSON.stringify(serviceToken));
        assertEquals(serviceToken.role, "viewer");

        const { prompts } = await callGateway<ListPromptsResponse>(
          deployment,
          "GET",
          "/v1/prompts",
          200,
          { bearerToken: serviceToken.accessToken },
        );
        assertEquals(prompts.map((prompt) => prompt.name), [promptName]);
        await callGateway(deployment, "POST", "/v1/prompts", 403, {
          bearerToken: serviceToken.accessToken,
          body: { name: `${promptName}-service`, type: "text", text: "Not allowed" },
        });

        // Identity's internal API takes a service token, not a user's.
        const resolveResponse = await fetch(
          `${internalAccess.identityUrl}/internal/v1/api-keys/resolve`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${admin.accessToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ apiKey: deployment.apiKey }),
          },
        );
        assertEquals(resolveResponse.status, 401);
        await resolveResponse.body?.cancel();
        const wrongSecretResponse = await fetch(
          `${internalAccess.identityUrl}/internal/v1/service-tokens`,
          {
            method: "POST",
            headers: {
              authorization: `Basic ${btoa(`${internalAccess.clientId}:wrong-secret`)}`,
              "content-type": "application/json",
            },
            body: "{}",
          },
        );
        assertEquals(wrongSecretResponse.status, 401);
        await wrongSecretResponse.body?.cancel();
      },
    });
  } finally {
    await deployment.stop();
  }
});
