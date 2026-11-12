/**
 * Starts the deployment under test. `E2E_DEPLOYMENT` selects it:
 *
 * With `E2E_OIDC_ISSUER_URL`, the address of Keycloak running with the realm in
 * `tests/e2e/keycloak`, the first two also sign people in through it. See `oidc-sign-in.test.ts`.
 *
 * - `all-in-one` (default): the local image's process, with SQLite.
 * - `services`: every service as a separate process on PostgreSQL; needs `E2E_POSTGRES_URL`, a
 *   server on which each service uses its own database `<service>_e2e`, created on first start.
 * - `external`: an already running deployment described by `E2E_GATEWAY_URL`,
 *   `E2E_OTLP_HTTP_URL`, `E2E_OTLP_GRPC_ADDRESS`, `E2E_API_KEY` (the first Project's key, set as
 *   `BOOTSTRAP_PROJECT_API_KEY`), `E2E_ADMIN_EMAIL` and `E2E_ADMIN_PASSWORD` (the first
 *   administrator, set as `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`) and optionally
 *   `E2E_GRPC_ROOT_CERTIFICATE_FILE`.
 *
 * `E2E_SOURCE_DIRECTORY` runs the first two from another checkout, with its own dependencies
 * installed; the nightly performance run measures the previous run's commit that way.
 */

export interface RunningDeployment {
  gatewayUrl: string;
  otlpHttpUrl: string;
  otlpGrpcAddress: string;
  /** Certificate that signs the gRPC server's TLS certificate, or null for plaintext gRPC. */
  grpcRootCertificate: Uint8Array | null;
  /** An API key of the Project that the deployment created on first start. */
  apiKey: string;
  /** The first administrator: an Instance admin with the Role admin in the first Project. */
  admin: LocalAccount;
  /**
   * Identity's internal API and a service client registered there, for checking service tokens.
   * Only the services deployment reaches it: the others keep Identity inside, as production does.
   */
  identityInternalAccess: IdentityInternalAccess | null;
  /**
   * Whether the worker can call a Target that the test runs on this machine. An external
   * deployment, such as a container, has its own network.
   */
  canCallLocalTargets: boolean;
  stop(): Promise<void>;
}

export interface LocalAccount {
  email: string;
  password: string;
}

export interface IdentityInternalAccess {
  identityUrl: string;
  clientId: string;
  clientSecret: string;
}

const REPOSITORY_ROOT = withTrailingSlash(
  Deno.env.get("E2E_SOURCE_DIRECTORY") || new URL("../../", import.meta.url).pathname,
);
/** Configured keys need at least 32 characters. */
const E2E_API_KEY = "extispex_e2eProjectApiKey00000000000000000000000";
const E2E_ADMIN: LocalAccount = {
  email: "admin@e2e.extispex.test",
  password: "e2e-admin-password",
};
/** Client secrets need at least 32 characters, like configured keys. */
const SERVICE_CLIENT_SECRETS = {
  telemetry: "e2e-telemetry-client-secret-0000000000",
  prompt: "e2e-prompt-client-secret-000000000000000",
  evaluation: "e2e-evaluation-client-secret-0000000000",
  e2e: "e2e-test-client-secret-00000000000000000",
};
const E2E_OIDC_CLIENT_SECRET = "e2eOidcClientSecret";
/** 32 bytes in base64, as `MASTER_KEY` requires. */
const E2E_MASTER_KEY = "ZTJlLW1hc3Rlci1rZXktZm9yLXRlc3RzLW9ubHktMDA=";
const STARTUP_TIMEOUT_MILLISECONDS = 60_000;
/** Short waits, so that a missing root span does not cost a minute per attempt. */
const TRACE_COMPLETION_ENVIRONMENT = {
  EVALUATION_TELEMETRY_POLL_INTERVAL_MILLISECONDS: "200",
  EVALUATION_ROOT_SPAN_SETTLE_MILLISECONDS: "500",
  EVALUATION_ROOT_SPAN_TIMEOUT_MILLISECONDS: "3000",
};
/**
 * The data lifecycle runs every second instead of every ten minutes, so that retention and the
 * removal of a deleted Project's data show within a test. An external deployment needs the same.
 */
const DATA_LIFECYCLE_ENVIRONMENT = { DATA_LIFECYCLE_INTERVAL_MILLISECONDS: "1000" };
const SERVICE_PERMISSIONS = [
  "--allow-net",
  "--allow-env",
  "--allow-read",
  "--allow-write",
  "--allow-ffi",
  "--allow-sys",
];

export async function startDeployment(): Promise<RunningDeployment> {
  const deploymentKind = Deno.env.get("E2E_DEPLOYMENT") ?? "all-in-one";
  switch (deploymentKind) {
    case "all-in-one":
      return await startAllInOneDeployment();
    case "services":
      return await startServicesDeployment();
    case "external":
      return readExternalDeployment();
    default:
      throw new Error(`Unknown E2E_DEPLOYMENT "${deploymentKind}".`);
  }
}

/** The `OIDC_*` variables for an Identity behind this Gateway; none without Keycloak. */
function createOidcEnvironment(gatewayPort: number): Record<string, string> {
  const issuerUrl = Deno.env.get("E2E_OIDC_ISSUER_URL");
  if (!issuerUrl) return {};
  return {
    OIDC_ISSUER_URL: issuerUrl,
    OIDC_CLIENT_ID: "extispex",
    OIDC_CLIENT_SECRET: E2E_OIDC_CLIENT_SECRET,
    OIDC_REDIRECT_URL: `http://127.0.0.1:${gatewayPort}/v1/sign-in/oidc/callback`,
    OIDC_PROVIDER_NAME: "Keycloak",
    OIDC_ALLOW_INSECURE_HTTP: "enabled",
  };
}

async function startAllInOneDeployment(): Promise<RunningDeployment> {
  const workingDirectory = await Deno.makeTempDir({ prefix: "extispex-e2e-" });
  const tlsFiles = await createSelfSignedCertificate(workingDirectory);
  const [otlpHttpPort, otlpGrpcPort, gatewayPort] = await reserveFreePorts(3);
  const allInOneProcess = startDenoProcess("all-in-one", "apps/all-in-one/src/main.ts", {
    DATA_DIRECTORY: `${workingDirectory}/data`,
    BOOTSTRAP_PROJECT_API_KEY: E2E_API_KEY,
    BOOTSTRAP_ADMIN_EMAIL: E2E_ADMIN.email,
    BOOTSTRAP_ADMIN_PASSWORD: E2E_ADMIN.password,
    TELEMETRY_HTTP_PORT: String(otlpHttpPort),
    TELEMETRY_GRPC_PORT: String(otlpGrpcPort),
    GATEWAY_PORT: String(gatewayPort),
    TELEMETRY_GRPC_TLS_CERTIFICATE_FILE: tlsFiles.certificateFile,
    TELEMETRY_GRPC_TLS_PRIVATE_KEY_FILE: tlsFiles.privateKeyFile,
    ...TRACE_COMPLETION_ENVIRONMENT,
    ...DATA_LIFECYCLE_ENVIRONMENT,
    ...createOidcEnvironment(gatewayPort),
  });
  const deployment = {
    canCallLocalTargets: true,
    gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
    otlpHttpUrl: `http://127.0.0.1:${otlpHttpPort}`,
    otlpGrpcAddress: `localhost:${otlpGrpcPort}`,
    grpcRootCertificate: await Deno.readFile(tlsFiles.certificateFile),
    apiKey: E2E_API_KEY,
    admin: E2E_ADMIN,
    identityInternalAccess: null,
    stop: async () => {
      await allInOneProcess.stop();
      await Deno.remove(workingDirectory, { recursive: true });
    },
  };
  await waitUntilHealthy([deployment.gatewayUrl, deployment.otlpHttpUrl], [allInOneProcess]);
  return deployment;
}

async function startServicesDeployment(): Promise<RunningDeployment> {
  const postgresServerUrl = Deno.env.get("E2E_POSTGRES_URL");
  if (!postgresServerUrl) {
    throw new Error("E2E_POSTGRES_URL is required for the services deployment.");
  }
  const workingDirectory = await Deno.makeTempDir({ prefix: "extispex-e2e-" });
  const tlsFiles = await createSelfSignedCertificate(workingDirectory);
  const [otlpHttpPort, otlpGrpcPort, promptPort, identityPort, evaluationPort, gatewayPort] =
    await reserveFreePorts(6);
  const identityUrl = `http://127.0.0.1:${identityPort}`;
  const identityProcess = startDenoProcess("identity", "services/identity/src/main.ts", {
    IDENTITY_DATABASE_URL: replaceDatabaseName(postgresServerUrl, "identity_e2e"),
    MASTER_KEY: E2E_MASTER_KEY,
    LOCAL_ACCOUNTS: "enabled",
    SERVICE_CLIENTS: Object.entries(SERVICE_CLIENT_SECRETS)
      .map(([clientId, clientSecret]) => `${clientId}:${clientSecret}`)
      .join(","),
    BOOTSTRAP_PROJECT_API_KEY: E2E_API_KEY,
    BOOTSTRAP_ADMIN_EMAIL: E2E_ADMIN.email,
    BOOTSTRAP_ADMIN_PASSWORD: E2E_ADMIN.password,
    IDENTITY_PORT: String(identityPort),
    ...DATA_LIFECYCLE_ENVIRONMENT,
    ...createOidcEnvironment(gatewayPort),
  });
  const telemetryProcess = startDenoProcess("telemetry", "services/telemetry/src/main.ts", {
    TELEMETRY_DATABASE_URL: replaceDatabaseName(postgresServerUrl, "telemetry_e2e"),
    IDENTITY_URL: identityUrl,
    IDENTITY_CLIENT_SECRET: SERVICE_CLIENT_SECRETS.telemetry,
    TELEMETRY_HTTP_PORT: String(otlpHttpPort),
    TELEMETRY_GRPC_PORT: String(otlpGrpcPort),
    TELEMETRY_GRPC_TLS_CERTIFICATE_FILE: tlsFiles.certificateFile,
    TELEMETRY_GRPC_TLS_PRIVATE_KEY_FILE: tlsFiles.privateKeyFile,
    ...DATA_LIFECYCLE_ENVIRONMENT,
  });
  const promptProcess = startDenoProcess("prompt", "services/prompt/src/main.ts", {
    PROMPT_DATABASE_URL: replaceDatabaseName(postgresServerUrl, "prompt_e2e"),
    IDENTITY_URL: identityUrl,
    IDENTITY_CLIENT_SECRET: SERVICE_CLIENT_SECRETS.prompt,
    PROMPT_PORT: String(promptPort),
    ...DATA_LIFECYCLE_ENVIRONMENT,
  });
  const evaluationDatabaseUrl = replaceDatabaseName(postgresServerUrl, "evaluation_e2e");
  const evaluationApiProcess = startDenoProcess(
    "evaluation-api",
    "services/evaluation/src/main-api.ts",
    {
      EVALUATION_DATABASE_URL: evaluationDatabaseUrl,
      MASTER_KEY: E2E_MASTER_KEY,
      IDENTITY_URL: identityUrl,
      IDENTITY_CLIENT_SECRET: SERVICE_CLIENT_SECRETS.evaluation,
      EVALUATION_PORT: String(evaluationPort),
    },
  );
  const evaluationWorkerProcess = startDenoProcess(
    "evaluation-worker",
    "services/evaluation/src/main-worker.ts",
    {
      EVALUATION_DATABASE_URL: evaluationDatabaseUrl,
      MASTER_KEY: E2E_MASTER_KEY,
      TELEMETRY_URL: `http://127.0.0.1:${otlpHttpPort}`,
      PROMPT_URL: `http://127.0.0.1:${promptPort}`,
      IDENTITY_URL: identityUrl,
      IDENTITY_CLIENT_SECRET: SERVICE_CLIENT_SECRETS.evaluation,
      // The sample Target runs on this machine; production lists its own Targets.
      EVALUATION_TARGET_ALLOWED_DESTINATIONS: "127.0.0.1",
      ...DATA_LIFECYCLE_ENVIRONMENT,
      // So do the fake SMTP server and webhook that receive Reports.
      EVALUATION_REPORT_ALLOWED_DESTINATIONS: "127.0.0.1",
      PUBLIC_UI_URL: `http://127.0.0.1:${gatewayPort}`,
      // So does the fake LLM provider.
      EVALUATION_LLM_PROVIDER_ALLOWED_DESTINATIONS: "127.0.0.1",
      ...TRACE_COMPLETION_ENVIRONMENT,
    },
  );
  const gatewayProcess = startDenoProcess("gateway", "services/gateway/src/main.ts", {
    TELEMETRY_URL: `http://127.0.0.1:${otlpHttpPort}`,
    PROMPT_URL: `http://127.0.0.1:${promptPort}`,
    IDENTITY_URL: identityUrl,
    EVALUATION_URL: `http://127.0.0.1:${evaluationPort}`,
    GATEWAY_PORT: String(gatewayPort),
    WEB_ASSETS_DIRECTORY: `${REPOSITORY_ROOT}apps/web/dist`,
  });
  const deployment = {
    canCallLocalTargets: true,
    gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
    otlpHttpUrl: `http://127.0.0.1:${otlpHttpPort}`,
    otlpGrpcAddress: `localhost:${otlpGrpcPort}`,
    grpcRootCertificate: await Deno.readFile(tlsFiles.certificateFile),
    apiKey: E2E_API_KEY,
    admin: E2E_ADMIN,
    identityInternalAccess: {
      identityUrl,
      clientId: "e2e",
      clientSecret: SERVICE_CLIENT_SECRETS.e2e,
    },
    stop: async () => {
      await Promise.all([
        gatewayProcess.stop(),
        promptProcess.stop(),
        evaluationApiProcess.stop(),
        evaluationWorkerProcess.stop(),
        telemetryProcess.stop(),
        identityProcess.stop(),
      ]);
      await Deno.remove(workingDirectory, { recursive: true });
    },
  };
  await waitUntilHealthy(
    [
      identityUrl,
      deployment.gatewayUrl,
      deployment.otlpHttpUrl,
      `http://127.0.0.1:${promptPort}`,
      `http://127.0.0.1:${evaluationPort}`,
    ],
    [
      identityProcess,
      telemetryProcess,
      promptProcess,
      evaluationApiProcess,
      evaluationWorkerProcess,
      gatewayProcess,
    ],
  );
  return deployment;
}

/** The same PostgreSQL server and credentials with another database. */
function replaceDatabaseName(serverUrl: string, databaseName: string): string {
  const databaseUrl = new URL(serverUrl);
  databaseUrl.pathname = `/${databaseName}`;
  return databaseUrl.toString();
}

function readExternalDeployment(): RunningDeployment {
  const readRequired = (variableName: string) => {
    const variableValue = Deno.env.get(variableName);
    if (!variableValue) {
      throw new Error(`${variableName} is required for the external deployment.`);
    }
    return variableValue;
  };
  const rootCertificateFile = Deno.env.get("E2E_GRPC_ROOT_CERTIFICATE_FILE");
  return {
    gatewayUrl: readRequired("E2E_GATEWAY_URL"),
    otlpHttpUrl: readRequired("E2E_OTLP_HTTP_URL"),
    otlpGrpcAddress: readRequired("E2E_OTLP_GRPC_ADDRESS"),
    grpcRootCertificate: rootCertificateFile ? Deno.readFileSync(rootCertificateFile) : null,
    apiKey: readRequired("E2E_API_KEY"),
    admin: { email: readRequired("E2E_ADMIN_EMAIL"), password: readRequired("E2E_ADMIN_PASSWORD") },
    identityInternalAccess: null,
    canCallLocalTargets: false,
    stop: () => Promise.resolve(),
  };
}

interface ManagedProcess {
  name: string;
  readOutput(): string;
  hasExited(): boolean;
  stop(): Promise<void>;
}

function startDenoProcess(
  processName: string,
  entryPoint: string,
  environmentVariables: Record<string, string>,
): ManagedProcess {
  const childProcess = new Deno.Command(Deno.execPath(), {
    args: ["run", ...SERVICE_PERMISSIONS, entryPoint],
    cwd: REPOSITORY_ROOT,
    env: { ...environmentVariables, NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const outputChunks: string[] = [];
  const collectOutput = async (outputStream: ReadableStream<Uint8Array>) => {
    for await (const outputText of outputStream.pipeThrough(new TextDecoderStream())) {
      outputChunks.push(outputText);
    }
  };
  const outputCollection = Promise.all([
    collectOutput(childProcess.stdout),
    collectOutput(childProcess.stderr),
  ]);
  let exited = false;
  const exitStatus = childProcess.status.then((status) => {
    exited = true;
    return status;
  });
  return {
    name: processName,
    readOutput: () => outputChunks.join(""),
    hasExited: () => exited,
    stop: async () => {
      if (!exited) {
        childProcess.kill("SIGTERM");
      }
      await exitStatus;
      await outputCollection;
    },
  };
}

async function waitUntilHealthy(baseUrls: string[], processes: ManagedProcess[]): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MILLISECONDS;
  for (const baseUrl of baseUrls) {
    while (true) {
      const exitedProcess = processes.find((managedProcess) => managedProcess.hasExited());
      if (exitedProcess) {
        throw new Error(
          `${exitedProcess.name} exited during startup:\n${exitedProcess.readOutput()}`,
        );
      }
      try {
        const healthResponse = await fetch(`${baseUrl}/health`);
        await healthResponse.body?.cancel();
        if (healthResponse.ok) break;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) {
        const processOutput = processes.map((managedProcess) =>
          `--- ${managedProcess.name}\n${managedProcess.readOutput()}`
        ).join("\n");
        await Promise.all(processes.map((managedProcess) => managedProcess.stop()));
        throw new Error(`${baseUrl} did not become healthy in time.\n${processOutput}`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    }
  }
}

async function reserveFreePorts(portCount: number): Promise<number[]> {
  const listeners = Array.from(
    { length: portCount },
    () => Deno.listen({ hostname: "127.0.0.1", port: 0 }),
  );
  const ports = listeners.map((listener) => (listener.addr as Deno.NetAddr).port);
  for (const listener of listeners) {
    listener.close();
  }
  return await Promise.resolve(ports);
}

async function createSelfSignedCertificate(
  directory: string,
): Promise<{ certificateFile: string; privateKeyFile: string }> {
  const certificateFile = `${directory}/grpc-certificate.pem`;
  const privateKeyFile = `${directory}/grpc-private-key.pem`;
  const opensslResult = await new Deno.Command("openssl", {
    args: [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      privateKeyFile,
      "-out",
      certificateFile,
    ],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!opensslResult.success) {
    throw new Error(`openssl failed: ${new TextDecoder().decode(opensslResult.stderr)}`);
  }
  return { certificateFile, privateKeyFile };
}

function withTrailingSlash(directory: string): string {
  return directory.endsWith("/") ? directory : `${directory}/`;
}
