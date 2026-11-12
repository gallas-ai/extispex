import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import type { DestinationAllowlist } from "./destination-allowlist.ts";

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
}

export type PostResult = { statusCode: number; body: string } | { status: "too_large" };

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
    const clientRequest = send(url, {
      method: "POST",
      headers,
      // A new connection for each call, so that every call goes through the lookup above.
      agent: false,
      lookup,
      signal,
    } as http.RequestOptions, (incoming) => {
      const chunks: Uint8Array[] = [];
      let byteCount = 0;
      incoming.on("data", (chunk: Uint8Array) => {
        byteCount += chunk.length;
        if (byteCount > options.maximumResponseBytes) {
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
        resolvePost({
          statusCode: incoming.statusCode ?? 0,
          body: new TextDecoder().decode(merged),
        });
      });
      incoming.on("error", rejectPost);
    });
    clientRequest.on("error", rejectPost);
    clientRequest.end(body);
  });
}
