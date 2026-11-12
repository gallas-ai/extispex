/**
 * A minimal HTTP proxy for the Target client's tests. It accepts CONNECT tunnels and requests in
 * absolute form, connects every host name to 127.0.0.1, and records the request lines it saw.
 */
export interface TestProxy {
  url: string;
  /** Request lines such as `CONNECT agent.example.test:443` and `POST http://…`, and their headers. */
  requests: Array<{ requestLine: string; headers: Headers }>;
  stop(): Promise<void>;
}

const HEAD_END = new TextEncoder().encode("\r\n\r\n");

export function startTestProxy(): TestProxy {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const requests: TestProxy["requests"] = [];
  const connections = new Set<Deno.Conn>();
  const handleConnection = async (clientConnection: Deno.Conn) => {
    connections.add(clientConnection);
    try {
      const { head, rest } = await readHead(clientConnection);
      const [requestLine, ...headerLines] = head.split("\r\n");
      const headers = new Headers();
      for (const headerLine of headerLines) {
        const separator = headerLine.indexOf(":");
        if (separator > 0) {
          headers.set(
            headerLine.slice(0, separator).trim(),
            headerLine.slice(separator + 1).trim(),
          );
        }
      }
      requests.push({ requestLine: requestLine.split(" ").slice(0, 2).join(" "), headers });
      const [method, target] = requestLine.split(" ");
      if (method === "CONNECT") {
        const port = Number(target.slice(target.lastIndexOf(":") + 1));
        const upstream = await Deno.connect({ hostname: "127.0.0.1", port });
        connections.add(upstream);
        await clientConnection.write(
          new TextEncoder().encode("HTTP/1.1 200 Connection Established\r\n\r\n"),
        );
        await pipeBothWays(clientConnection, upstream, rest);
        return;
      }
      const targetUrl = new URL(target);
      const upstream = await Deno.connect({
        hostname: "127.0.0.1",
        port: Number(targetUrl.port || 80),
      });
      connections.add(upstream);
      const rewrittenHead = [
        `${method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1`,
        ...headerLines.filter((line) => !/^proxy-/i.test(line)),
      ].join("\r\n");
      await upstream.write(new TextEncoder().encode(`${rewrittenHead}\r\n\r\n`));
      await pipeBothWays(clientConnection, upstream, rest);
    } catch {
      // A test ended the connection.
    } finally {
      for (const connection of [clientConnection]) {
        connections.delete(connection);
        try {
          connection.close();
        } catch {
          // Already closed.
        }
      }
    }
  };
  const accepting = (async () => {
    for await (const clientConnection of listener) {
      handleConnection(clientConnection);
    }
  })().catch(() => {});
  return {
    url: `http://127.0.0.1:${(listener.addr as Deno.NetAddr).port}`,
    requests,
    stop: async () => {
      listener.close();
      for (const connection of connections) {
        try {
          connection.close();
        } catch {
          // Already closed.
        }
      }
      await accepting;
    },
  };
}

async function readHead(connection: Deno.Conn): Promise<{ head: string; rest: Uint8Array }> {
  let buffered = new Uint8Array(0);
  const chunk = new Uint8Array(16_384);
  while (true) {
    const byteCount = await connection.read(chunk);
    if (byteCount === null) throw new Error("The client closed the connection.");
    const merged = new Uint8Array(buffered.length + byteCount);
    merged.set(buffered);
    merged.set(chunk.subarray(0, byteCount), buffered.length);
    buffered = merged;
    const headEnd = findSequence(buffered, HEAD_END);
    if (headEnd >= 0) {
      return {
        head: new TextDecoder().decode(buffered.subarray(0, headEnd)),
        rest: buffered.subarray(headEnd + HEAD_END.length),
      };
    }
  }
}

function findSequence(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let start = 0; start + needle.length <= haystack.length; start++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return start;
  }
  return -1;
}

async function pipeBothWays(
  clientConnection: Deno.Conn,
  upstream: Deno.Conn,
  alreadyRead: Uint8Array,
): Promise<void> {
  if (alreadyRead.length > 0) await upstream.write(alreadyRead);
  const copy = async (from: Deno.Conn, to: Deno.Conn) => {
    const chunk = new Uint8Array(16_384);
    try {
      while (true) {
        const byteCount = await from.read(chunk);
        if (byteCount === null) break;
        await to.write(chunk.subarray(0, byteCount));
      }
    } catch {
      // The other side closed.
    }
    try {
      await to.closeWrite();
    } catch {
      // Already closed.
    }
  };
  await Promise.all([copy(clientConnection, upstream), copy(upstream, clientConnection)]);
  try {
    upstream.close();
  } catch {
    // Already closed.
  }
}
