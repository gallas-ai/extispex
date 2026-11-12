import { InvalidConfigurationError } from "@extispex/service-runtime";

/** The standard proxy variables, as an operator sets them for the worker. */
export interface ProxyEnvironment {
  /** `HTTP_PROXY`: the proxy for `http://` destinations. */
  httpProxy?: string;
  /** `HTTPS_PROXY`: the proxy for `https://` destinations. */
  httpsProxy?: string;
  /** `NO_PROXY`: destinations that the worker calls directly. */
  noProxy?: string;
}

/** Which proxy, if any, carries the worker's call to a Target, an LLM provider or a webhook. */
export interface ProxyRouting {
  /** The proxy for this destination's URL, or null to connect directly. */
  selectProxy(targetUrl: URL): URL | null;
}

export const DIRECT_CONNECTIONS: ProxyRouting = { selectProxy: () => null };

/**
 * Reads the proxy settings the way curl and most HTTP clients do. `NO_PROXY` is a comma-separated
 * list of host names, each also matching its subdomains (`company.example` and `.company.example`
 * both match `agent.company.example`), `*.` wildcards, `host:port`, IP addresses, CIDR ranges for
 * IP addresses, and `*` for everything.
 */
export function parseProxyRouting(environment: ProxyEnvironment): ProxyRouting {
  const httpProxy = parseProxyUrl("HTTP_PROXY", environment.httpProxy);
  const httpsProxy = parseProxyUrl("HTTPS_PROXY", environment.httpsProxy);
  if (httpProxy === null && httpsProxy === null) return DIRECT_CONNECTIONS;
  const bypassEntries = (environment.noProxy ?? "").split(",").map((entry) => entry.trim())
    .filter(Boolean).map(parseBypassEntry);
  return {
    selectProxy(targetUrl) {
      const proxy = targetUrl.protocol === "https:" ? httpsProxy : httpProxy;
      if (proxy === null) return null;
      const hostName = normalizeHostName(targetUrl.hostname);
      const port = targetUrl.port === "" ? (targetUrl.protocol === "https:" ? 443 : 80) : Number(
        targetUrl.port,
      );
      return bypassEntries.some((entry) => entry(hostName, port)) ? null : proxy;
    },
  };
}

function parseProxyUrl(variableName: string, configuredValue: string | undefined): URL | null {
  const trimmedValue = configuredValue?.trim();
  if (!trimmedValue) return null;
  // A proxy given as `host:port` without a scheme is common and means plain HTTP.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedValue)
    ? trimmedValue
    : `http://${trimmedValue}`;
  let proxyUrl: URL;
  try {
    proxyUrl = new URL(withScheme);
  } catch {
    throw new InvalidConfigurationError(`${variableName} is not a URL.`);
  }
  if (proxyUrl.protocol !== "http:") {
    throw new InvalidConfigurationError(
      `${variableName} must be an http:// proxy; the worker talks to the proxy in plain HTTP and ` +
        "reaches HTTPS destinations through a CONNECT tunnel.",
    );
  }
  return proxyUrl;
}

type BypassEntry = (hostName: string, port: number) => boolean;

function parseBypassEntry(entry: string): BypassEntry {
  if (entry === "*") return () => true;
  const cidrMatch = /^([0-9.]+|[0-9a-f:]+)\/(\d+)$/i.exec(entry);
  if (cidrMatch !== null) {
    const network = parseAddress(cidrMatch[1]);
    const prefixLength = Number(cidrMatch[2]);
    if (network === null || prefixLength > network.length * 8) {
      throw new InvalidConfigurationError(`"${entry}" in NO_PROXY is not a valid CIDR range.`);
    }
    return (hostName) => {
      const address = parseAddress(hostName);
      return address !== null && isInNetwork(address, network, prefixLength);
    };
  }
  const hostPortMatch = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry);
  const hostPart = hostPortMatch === null ? entry : hostPortMatch[1];
  const port = hostPortMatch?.[2] === undefined ? null : Number(hostPortMatch[2]);
  const domain = normalizeHostName(hostPart.replace(/^\*?\./, ""));
  return (hostName, targetPort) => {
    if (port !== null && port !== targetPort) return false;
    return hostName === domain || hostName.endsWith(`.${domain}`);
  };
}

function normalizeHostName(hostName: string): string {
  return hostName.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
}

function parseAddress(text: string): number[] | null {
  const ipv4Parts = text.split(".");
  if (ipv4Parts.length === 4 && ipv4Parts.every((part) => /^\d{1,3}$/.test(part))) {
    const bytes = ipv4Parts.map(Number);
    return bytes.every((byte) => byte <= 255) ? bytes : null;
  }
  if (!text.includes(":")) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toBytes = (half: string) =>
    half === "" ? [] : half.split(":").flatMap((group) => {
      const groupValue = parseInt(group, 16);
      return [groupValue >> 8, groupValue & 0xff];
    });
  const head = toBytes(halves[0]);
  const tail = halves.length === 2 ? toBytes(halves[1]) : [];
  if ([...head, ...tail].some(Number.isNaN)) return null;
  const missingByteCount = 16 - head.length - tail.length;
  if (halves.length === 1 ? missingByteCount !== 0 : missingByteCount < 2) return null;
  return [...head, ...new Array(missingByteCount).fill(0), ...tail];
}

function isInNetwork(address: number[], network: number[], prefixLength: number): boolean {
  if (address.length !== network.length) return false;
  for (let byteIndex = 0; byteIndex * 8 < prefixLength; byteIndex++) {
    const maskedBits = Math.min(prefixLength - byteIndex * 8, 8);
    const mask = (0xff << (8 - maskedBits)) & 0xff;
    if ((address[byteIndex] & mask) !== (network[byteIndex] & mask)) return false;
  }
  return true;
}
