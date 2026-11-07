/**
 * Starts the deployment under test. `E2E_DEPLOYMENT` selects it:
 *
 * - `all-in-one` (default): the local image's process, with SQLite.
 * - `services`: Telemetry and Gateway as separate processes; needs `E2E_TELEMETRY_DATABASE_URL`.
 * - `external`: an already running deployment described by `E2E_GATEWAY_URL`,
 *   `E2E_OTLP_HTTP_URL`, `E2E_OTLP_GRPC_ADDRESS`, `E2E_API_KEY` and optionally
 *   `E2E_GRPC_ROOT_CERTIFICATE_FILE`.
 */

export interface RunningDeployment {
  gatewayUrl: string;
  otlpHttpUrl: string;
  otlpGrpcAddress: string;
  /** Certificate that signs the gRPC server's TLS certificate, or null for plaintext gRPC. */
  grpcRootCertificate: Uint8Array | null;
  apiKey: string;
  stop(): Promise<void>;
}

const REPOSITORY_ROOT = new URL("../../", import.meta.url).pathname;
const E2E_API_KEY = "e2e-api-key";
const STARTUP_TIMEOUT_MILLISECONDS = 60_000;
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

async function startAllInOneDeployment(): Promise<RunningDeployment> {
  const workingDirectory = await Deno.makeTempDir({ prefix: "extispex-e2e-" });
  const tlsFiles = await createSelfSignedCertificate(workingDirectory);
  const [otlpHttpPort, otlpGrpcPort, gatewayPort] = await reserveFreePorts(3);
  const allInOneProcess = startDenoProcess("all-in-one", "apps/all-in-one/src/main.ts", {
    DATA_DIRECTORY: `${workingDirectory}/data`,
    STATIC_API_KEYS: `${E2E_API_KEY}=e2e-project`,
    TELEMETRY_HTTP_PORT: String(otlpHttpPort),
    TELEMETRY_GRPC_PORT: String(otlpGrpcPort),
    GATEWAY_PORT: String(gatewayPort),
    TELEMETRY_GRPC_TLS_CERTIFICATE_FILE: tlsFiles.certificateFile,
    TELEMETRY_GRPC_TLS_PRIVATE_KEY_FILE: tlsFiles.privateKeyFile,
  });
  const deployment = {
    gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
    otlpHttpUrl: `http://127.0.0.1:${otlpHttpPort}`,
    otlpGrpcAddress: `localhost:${otlpGrpcPort}`,
    grpcRootCertificate: await Deno.readFile(tlsFiles.certificateFile),
    apiKey: E2E_API_KEY,
    stop: async () => {
      await allInOneProcess.stop();
      await Deno.remove(workingDirectory, { recursive: true });
    },
  };
  await waitUntilHealthy([deployment.gatewayUrl, deployment.otlpHttpUrl], [allInOneProcess]);
  return deployment;
}

async function startServicesDeployment(): Promise<RunningDeployment> {
  const databaseUrl = Deno.env.get("E2E_TELEMETRY_DATABASE_URL");
  if (!databaseUrl) {
    throw new Error("E2E_TELEMETRY_DATABASE_URL is required for the services deployment.");
  }
  const workingDirectory = await Deno.makeTempDir({ prefix: "extispex-e2e-" });
  const tlsFiles = await createSelfSignedCertificate(workingDirectory);
  const [otlpHttpPort, otlpGrpcPort, gatewayPort] = await reserveFreePorts(3);
  const telemetryProcess = startDenoProcess("telemetry", "services/telemetry/src/main.ts", {
    TELEMETRY_DATABASE_URL: databaseUrl,
    STATIC_API_KEYS: `${E2E_API_KEY}=e2e-project`,
    TELEMETRY_HTTP_PORT: String(otlpHttpPort),
    TELEMETRY_GRPC_PORT: String(otlpGrpcPort),
    TELEMETRY_GRPC_TLS_CERTIFICATE_FILE: tlsFiles.certificateFile,
    TELEMETRY_GRPC_TLS_PRIVATE_KEY_FILE: tlsFiles.privateKeyFile,
  });
  const gatewayProcess = startDenoProcess("gateway", "services/gateway/src/main.ts", {
    TELEMETRY_URL: `http://127.0.0.1:${otlpHttpPort}`,
    GATEWAY_PORT: String(gatewayPort),
    WEB_ASSETS_DIRECTORY: `${REPOSITORY_ROOT}apps/web/dist`,
  });
  const deployment = {
    gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
    otlpHttpUrl: `http://127.0.0.1:${otlpHttpPort}`,
    otlpGrpcAddress: `localhost:${otlpGrpcPort}`,
    grpcRootCertificate: await Deno.readFile(tlsFiles.certificateFile),
    apiKey: E2E_API_KEY,
    stop: async () => {
      await Promise.all([gatewayProcess.stop(), telemetryProcess.stop()]);
      await Deno.remove(workingDirectory, { recursive: true });
    },
  };
  await waitUntilHealthy(
    [deployment.gatewayUrl, deployment.otlpHttpUrl],
    [telemetryProcess, gatewayProcess],
  );
  return deployment;
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
