import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import process from "node:process";
import tls from "node:tls";
import type { DestinationAllowlist } from "./destination-allowlist.ts";
import type { ProxyRouting } from "./proxy-settings.ts";

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type ResolveHostAddresses = (hostName: string) => Promise<ResolvedAddress[]>;

export function resolveWithSystem(hostName: string): Promise<ResolvedAddress[]> {
  return dns.promises.lookup(hostName, { all: true });
}

/** The destination's name resolved to an address that the allowlist does not allow. */
export class DestinationNotAllowedError extends Error {
  override name = "DestinationNotAllowedError";
}

export interface AllowedDestinationOptions {
  allowlist: DestinationAllowlist;
  resolveHostAddresses: ResolveHostAddresses;
  /** The message of the {@link DestinationNotAllowedError}, naming the setting to change. */
  notAllowedReason: string;
  maximumResponseBytes: number;
  /** From `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`; direct connections when not given. */
  proxyRouting?: ProxyRouting;
}

export type PostResult =
  | {
    statusCode: number;
    body: string;
    /** The `retry-after` header, which a busy server may send. */
    retryAfter: string | undefined;
  }
  | { status: "too_large" };

/**
 * Resolves a host name once and checks every address. Connecting to exactly these addresses means
 * a DNS record that changes between the check and the connection cannot redirect the call.
 */
export async function resolveAllowedAddresses(
  url: URL,
  options: Pick<
    AllowedDestinationOptions,
    "allowlist" | "resolveHostAddresses" | "notAllowedReason"
  >,
): Promise<ResolvedAddress[]> {
  const addresses = await options.resolveHostAddresses(url.hostname.replace(/^\[|\]$/g, ""));
  if (
    addresses.length === 0 ||
    !options.allowlist.areResolvedAddressesAllowed(url, addresses.map((item) => item.address))
  ) {
    throw new DestinationNotAllowedError(options.notAllowedReason);
  }
  return addresses;
}

/**
 * Posts JSON and reads the answer without following redirects. The address is resolved once, here,
 * and the connection uses exactly the addresses that were checked: a DNS record that changes
 * between the check and the connection cannot redirect the call.
 */
export function postToAllowedDestination(
  url: URL,
  headers: Record<string, string>,
  body: string,
  options: AllowedDestinationOptions,
  signal: AbortSignal,
): Promise<PostResult> {
  const proxyUrl = options.proxyRouting?.selectProxy(url) ?? null;
  if (proxyUrl !== null) {
    if (!options.allowlist.isUrlAllowedThroughProxy(url)) {
      return Promise.reject(
        new DestinationNotAllowedError(
          `${options.notAllowedReason} It is called through a proxy, which resolves the name, so ` +
            "the list must name its host: a CIDR range allows only an address written in the URL.",
        ),
      );
    }
    return postThroughProxy(url, proxyUrl, headers, body, options.maximumResponseBytes, signal);
  }
  return new Promise((resolvePost, rejectPost) => {
    type LookupCallback = (
      error: Error | null,
      addresses: ResolvedAddress[] | string,
      family?: number,
    ) => void;
    const lookup = (_hostName: string, lookupOptions: unknown, callback: LookupCallback) => {
      resolveAllowedAddresses(url, options).then((addresses) => {
        if ((lookupOptions as { all?: boolean }).all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      }).catch((error) => callback(error, []));
    };
    const send = url.protocol === "https:" ? https.request : http.request;
    const clientRequest = send(
      url,
      {
        method: "POST",
        headers,
        // A new connection for each call, so that every call goes through the lookup above.
        agent: false,
        lookup,
        signal,
      } as http.RequestOptions,
      (incoming) =>
        readAnswer(incoming, clientRequest, options.maximumResponseBytes, resolvePost, rejectPost),
    );
    clientRequest.on("error", rejectPost);
    clientRequest.end(body);
  });
}

/** Reads an answer, giving up once it is larger than `maximumResponseBytes`. */
function readAnswer(
  incoming: http.IncomingMessage,
  clientRequest: http.ClientRequest,
  maximumResponseBytes: number,
  resolvePost: (result: PostResult) => void,
  rejectPost: (error: Error) => void,
): void {
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  incoming.on("data", (chunk: Uint8Array) => {
    byteCount += chunk.length;
    if (byteCount > maximumResponseBytes) {
      clientRequest.destroy();
      resolvePost({ status: "too_large" });
      return;
    }
    chunks.push(chunk);
  });
  incoming.on("end", () => {
    const merged = new Uint8Array(byteCount);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    const retryAfter = incoming.headers["retry-after"];
    resolvePost({
      statusCode: incoming.statusCode ?? 0,
      body: new TextDecoder().decode(merged),
      retryAfter: Array.isArray(retryAfter) ? retryAfter[0] : retryAfter,
    });
  });
  incoming.on("error", rejectPost);
}

let trustedCertificates: string[] | undefined;

/**
 * The public certificate authorities and those in `NODE_EXTRA_CA_CERTS`. A direct call gets both
 * from the runtime, but Deno does not add the extra ones to TLS over an existing socket, so the
 * tunnel passes them itself. The file is read once, as the runtime reads it once at start.
 */
function readTrustedCertificates(): string[] {
  if (trustedCertificates === undefined) {
    const extraCertificatesFile = process.env.NODE_EXTRA_CA_CERTS;
    trustedCertificates = [
      ...tls.rootCertificates,
      ...(extraCertificatesFile ? [Deno.readTextFileSync(extraCertificatesFile)] : []),
    ];
  }
  return trustedCertificates;
}

/** `Proxy-Authorization` for a proxy URL with a user name and password, such as `http://u:p@proxy`. */
function createProxyHeaders(proxyUrl: URL): Record<string, string> {
  if (proxyUrl.username === "") return {};
  const credentials = `${decodeURIComponent(proxyUrl.username)}:${
    decodeURIComponent(proxyUrl.password)
  }`;
  return { "proxy-authorization": `Basic ${btoa(credentials)}` };
}

function readPort(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/**
 * Posts JSON through an HTTP proxy, which resolves the destination's name and connects to it. An
 * `http://` destination gets the request in absolute form; an `https://` destination gets a CONNECT
 * tunnel, inside which the worker checks the certificate against the host name itself.
 */
function postThroughProxy(
  url: URL,
  proxyUrl: URL,
  headers: Record<string, string>,
  body: string,
  maximumResponseBytes: number,
  signal: AbortSignal,
): Promise<PostResult> {
  const proxyHeaders = createProxyHeaders(proxyUrl);
  const proxyPort = readPort(proxyUrl);
  return new Promise((resolvePost, rejectPost) => {
    if (url.protocol === "http:") {
      const clientRequest = http.request(
        {
          host: proxyUrl.hostname,
          port: proxyPort,
          method: "POST",
          path: url.href,
          headers: { ...headers, ...proxyHeaders, host: url.host },
          agent: false,
          signal,
        },
        (incoming) =>
          readAnswer(incoming, clientRequest, maximumResponseBytes, resolvePost, rejectPost),
      );
      clientRequest.on("error", rejectPost);
      clientRequest.end(body);
      return;
    }
    const authority = `${url.hostname}:${readPort(url)}`;
    const connectRequest = http.request({
      host: proxyUrl.hostname,
      port: proxyPort,
      method: "CONNECT",
      path: authority,
      headers: { ...proxyHeaders, host: authority },
      agent: false,
      signal,
    });
    connectRequest.on("connect", (proxyAnswer: http.IncomingMessage, tunnel: Socket) => {
      if (proxyAnswer.statusCode !== 200) {
        tunnel.destroy();
        rejectPost(new Error(`the proxy refused the tunnel with status ${proxyAnswer.statusCode}`));
        return;
      }
      const tlsSocket = tls.connect({
        socket: tunnel,
        servername: url.hostname.replace(/^\[|\]$/g, ""),
        ca: readTrustedCertificates(),
      });
      tlsSocket.on("error", rejectPost);
      // A one-off agent whose only connection is the tunnel; Deno ignores `createConnection` as a
      // request option.
      const tunnelAgent = new https.Agent();
      Object.assign(tunnelAgent, { createConnection: () => tlsSocket });
      const clientRequest = https.request(
        url,
        { method: "POST", headers, agent: tunnelAgent, signal },
        (incoming) => {
          incoming.on("end", () => tlsSocket.destroy());
          readAnswer(incoming, clientRequest, maximumResponseBytes, resolvePost, rejectPost);
        },
      );
      clientRequest.on("error", rejectPost);
      clientRequest.end(body);
    });
    connectRequest.on("error", rejectPost);
    connectRequest.end();
  });
}
