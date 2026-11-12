/**
 * Calls an HTTPS Target whose host name resolves to 127.0.0.1, directly or through the proxy given
 * as the third argument, and prints the result. Run in its own process, because
 * NODE_EXTRA_CA_CERTS is read when the process starts.
 */
import { parseDestinationAllowlist } from "../../src/targets/destination-allowlist.ts";
import { parseProxyRouting } from "../../src/targets/proxy-settings.ts";
import { createTargetClient } from "../../src/targets/target-client.ts";

const [port, hostName, proxyUrl] = Deno.args;
const client = createTargetClient({
  allowlist: parseDestinationAllowlist(`${hostName}, 127.0.0.0/8`),
  timeoutMilliseconds: 5_000,
  resolveHostAddresses: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
  proxyRouting: parseProxyRouting({ httpsProxy: proxyUrl }),
});
const result = await client.callTarget(
  { url: `https://${hostName}:${port}/evaluate`, credential: null },
  { input: "Hello", sessionId: null },
);
console.log(JSON.stringify(result));
