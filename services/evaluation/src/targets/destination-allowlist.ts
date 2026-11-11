import { InvalidConfigurationError } from "@extispex/service-runtime";

/**
 * Which destinations the worker may call, from `EVALUATION_TARGET_ALLOWED_DESTINATIONS` for
 * Targets and `EVALUATION_REPORT_ALLOWED_DESTINATIONS` for Report channels.
 */
export interface DestinationAllowlist {
  /** Refuses a URL that the list cannot allow, whatever its host name resolves to. */
  isUrlAllowed(url: URL): boolean;
  /** Decides on the addresses that a URL's host name resolved to. All of them must be allowed. */
  areResolvedAddressesAllowed(url: URL, addresses: string[]): boolean;
}

type AllowedEntry =
  | { kind: "host"; hostName: string; isWildcard: boolean; port: number | null }
  | { kind: "network"; addressBytes: number[]; prefixLength: number };

/** A single address, as bytes: four for IPv4, sixteen for IPv6. Null when it is not an address. */
function parseIpAddress(text: string): number[] | null {
  const address = text.replace(/^\[|\]$/g, "");
  if (address.includes(":")) return normalizeMappedAddress(parseIpv6(address));
  return parseIpv4(address);
}

function parseIpv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null;
  const bytes = parts.map(Number);
  return bytes.every((byte) => byte <= 255) ? bytes : null;
}

function parseIpv6(text: string): number[] | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (half: string): number[] | null => {
    if (half === "") return [];
    const bytes: number[] = [];
    const groups = half.split(":");
    for (const [position, group] of groups.entries()) {
      if (position === groups.length - 1 && group.includes(".")) {
        const embeddedIpv4 = parseIpv4(group);
        if (embeddedIpv4 === null) return null;
        bytes.push(...embeddedIpv4);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      const groupValue = parseInt(group, 16);
      bytes.push(groupValue >> 8, groupValue & 0xff);
    }
    return bytes;
  };
  const head = parseGroups(halves[0]);
  const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 16 ? head : null;
  const missingByteCount = 16 - head.length - tail.length;
  if (missingByteCount < 2) return null;
  return [...head, ...new Array(missingByteCount).fill(0), ...tail];
}

/** `::ffff:10.0.0.1` reaches the IPv4 address, so it is judged as one. */
function normalizeMappedAddress(bytes: number[] | null): number[] | null {
  if (bytes === null || bytes.length !== 16) return bytes;
  const isMapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff &&
    bytes[11] === 0xff;
  return isMapped ? bytes.slice(12) : bytes;
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

const PROTECTED_NETWORKS: Array<[number[], number]> = [
  [[0, 0, 0, 0], 8],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[224, 0, 0, 0], 4],
  [new Array(16).fill(0), 128],
  [[...new Array(15).fill(0), 1], 128],
  [[0xfe, 0x80, ...new Array(14).fill(0)], 10],
  [[0xff, ...new Array(15).fill(0)], 8],
];

/** The machine itself, link-local addresses such as cloud metadata services, and multicast. */
function isProtectedAddress(address: number[]): boolean {
  return PROTECTED_NETWORKS.some(([network, prefixLength]) =>
    isInNetwork(address, network, prefixLength)
  );
}

function parseEntry(entry: string, variableName: string): AllowedEntry {
  const invalid = () =>
    new InvalidConfigurationError(
      `"${entry}" in ${variableName} is not a host, a host:port, a ` +
        "*.wildcard host or a CIDR range.",
    );
  if (entry.includes("/")) {
    const [addressText, prefixText] = entry.split("/");
    const addressBytes = parseIpAddress(addressText);
    const prefixLength = Number(prefixText);
    if (
      addressBytes === null || !/^\d+$/.test(prefixText) ||
      prefixLength > addressBytes.length * 8
    ) {
      throw invalid();
    }
    return { kind: "network", addressBytes, prefixLength };
  }
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry) ??
    (parseIpv6(entry) === null ? null : [entry, entry, undefined]);
  if (match === null) throw invalid();
  const port = match[2] === undefined ? null : Number(match[2]);
  if (port !== null && (port < 1 || port > 65535)) throw invalid();
  const isWildcard = match[1].startsWith("*.");
  const hostName = normalizeHostName(isWildcard ? match[1].slice(2) : match[1]);
  if (hostName === "" || hostName.includes("*")) throw invalid();
  return { kind: "host", hostName, isWildcard, port };
}

function normalizeHostName(hostName: string): string {
  return hostName.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
}

function readPort(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/**
 * Parses the comma-separated list. `*` alone allows everything, and an empty list allows nothing.
 *
 * A host name that is listed may resolve to a private address, because internal Targets are the
 * usual case. It may not resolve to a protected address unless a CIDR range allows that address,
 * so a changed DNS record cannot point a listed name at the machine or at a metadata service.
 */
export function parseDestinationAllowlist(
  configuredList: string,
  variableName = "EVALUATION_TARGET_ALLOWED_DESTINATIONS",
): DestinationAllowlist {
  const entries = configuredList.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 1 && entries[0] === "*") {
    return { isUrlAllowed: () => true, areResolvedAddressesAllowed: () => true };
  }
  const allowedEntries = entries.map((entry) => parseEntry(entry, variableName));
  const hostEntries = allowedEntries.filter((entry) => entry.kind === "host");
  const networkEntries = allowedEntries.filter((entry) => entry.kind === "network");

  const isHostListed = (url: URL): boolean => {
    const hostName = normalizeHostName(url.hostname);
    const port = readPort(url);
    return hostEntries.some((entry) => {
      if (entry.port !== null && entry.port !== port) return false;
      return entry.isWildcard
        ? hostName.endsWith(`.${entry.hostName}`)
        : hostName === entry.hostName;
    });
  };
  const isInAllowedNetwork = (address: number[]) =>
    networkEntries.some((entry) => isInNetwork(address, entry.addressBytes, entry.prefixLength));

  const isUrlAllowed = (url: URL): boolean => {
    const addressInUrl = parseIpAddress(url.hostname);
    if (addressInUrl !== null) return isHostListed(url) || isInAllowedNetwork(addressInUrl);
    // A name that is not listed may still resolve into an allowed network.
    return isHostListed(url) || networkEntries.length > 0;
  };

  return {
    isUrlAllowed,
    areResolvedAddressesAllowed(url, addresses) {
      if (addresses.length === 0) return false;
      // An address written in the URL is not resolved, and listing it explicitly allows it.
      if (parseIpAddress(url.hostname) !== null) return isUrlAllowed(url);
      const isListed = isHostListed(url);
      return addresses.every((addressText) => {
        const address = parseIpAddress(addressText);
        if (address === null) return false;
        return isInAllowedNetwork(address) || (isListed && !isProtectedAddress(address));
      });
    },
  };
}
