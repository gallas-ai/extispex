/**
 * A small SMTP server for tests, so that sending a Report by email needs no extra container. It
 * speaks plain SMTP without TLS, accepts `AUTH PLAIN` and `AUTH LOGIN`, and keeps every message.
 */

export interface ReceivedEmail {
  /** The envelope sender from `MAIL FROM`. */
  envelopeSender: string;
  /** The envelope recipients from `RCPT TO`. */
  envelopeRecipients: string[];
  /** The user name and password the client signed in with, or null without `AUTH`. */
  signedInAs: { username: string; password: string } | null;
  /** The whole message as the client sent it, headers included. */
  rawMessage: string;
}

export interface FakeSmtpServer {
  hostName: string;
  port: number;
  receivedEmails: ReceivedEmail[];
  /**
   * The reply to the next `MAIL FROM` commands, such as `451 Try again later`, used once each.
   * Empty accepts every message.
   */
  queuedRefusals: string[];
  /** Resolves once this many messages have arrived. */
  waitForEmails(emailCount: number, timeoutMilliseconds?: number): Promise<ReceivedEmail[]>;
  stop(): Promise<void>;
}

const textEncoder = new TextEncoder();

function decodeBase64(encoded: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)));
}

/** The address inside `<…>`, as `MAIL FROM:<a@b>` and `RCPT TO:<c@d>` carry it. */
function readAngleAddress(argument: string): string {
  return /<([^>]*)>/.exec(argument)?.[1] ?? argument.trim();
}

export function startFakeSmtpServer(): FakeSmtpServer {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const receivedEmails: ReceivedEmail[] = [];
  const queuedRefusals: string[] = [];
  const openConnections = new Set<Deno.Conn>();
  const arrivalListeners = new Set<() => void>();

  const handleConnection = async (connection: Deno.Conn) => {
    openConnections.add(connection);
    const reply = (line: string) => connection.write(textEncoder.encode(`${line}\r\n`));
    let envelopeSender: string | null = null;
    let envelopeRecipients: string[] = [];
    let signedInAs: ReceivedEmail["signedInAs"] = null;
    let readingData = false;
    let pendingLogin: { step: "username" | "password"; username: string } | null = null;
    let dataLines: string[] = [];
    let buffered = "";
    try {
      await reply("220 fake-smtp.test ESMTP ready");
      for await (const chunk of connection.readable.pipeThrough(new TextDecoderStream())) {
        buffered += chunk;
        let lineEnd: number;
        while ((lineEnd = buffered.indexOf("\r\n")) !== -1) {
          const line = buffered.slice(0, lineEnd);
          buffered = buffered.slice(lineEnd + 2);
          if (readingData) {
            if (line === ".") {
              readingData = false;
              receivedEmails.push({
                envelopeSender: envelopeSender ?? "",
                envelopeRecipients,
                signedInAs,
                // A line that starts with a dot was sent with a second one in front.
                rawMessage: dataLines.map((dataLine) =>
                  dataLine.startsWith("..") ? dataLine.slice(1) : dataLine
                ).join("\r\n"),
              });
              envelopeSender = null;
              envelopeRecipients = [];
              dataLines = [];
              for (const notify of arrivalListeners) notify();
              await reply("250 2.0.0 Message accepted");
            } else {
              dataLines.push(line);
            }
            continue;
          }
          if (pendingLogin !== null) {
            if (pendingLogin.step === "username") {
              pendingLogin = { step: "password", username: decodeBase64(line) };
              await reply("334 UGFzc3dvcmQ6");
            } else {
              signedInAs = { username: pendingLogin.username, password: decodeBase64(line) };
              pendingLogin = null;
              await reply("235 2.7.0 Authentication successful");
            }
            continue;
          }
          const [command, ...argumentParts] = line.split(" ");
          const argument = argumentParts.join(" ");
          switch (command.toUpperCase()) {
            case "EHLO":
              await reply("250-fake-smtp.test");
              await reply("250-AUTH PLAIN LOGIN");
              await reply("250 8BITMIME");
              break;
            case "HELO":
              await reply("250 fake-smtp.test");
              break;
            case "AUTH": {
              const [mechanism, initialResponse] = argument.split(" ");
              if (mechanism.toUpperCase() === "PLAIN" && initialResponse !== undefined) {
                const [, username, password] = decodeBase64(initialResponse).split("\u0000");
                signedInAs = { username, password };
                await reply("235 2.7.0 Authentication successful");
              } else if (mechanism.toUpperCase() === "LOGIN") {
                pendingLogin = { step: "username", username: "" };
                await reply("334 VXNlcm5hbWU6");
              } else {
                await reply("504 5.5.4 Unrecognized authentication type");
              }
              break;
            }
            case "MAIL": {
              const refusal = queuedRefusals.shift();
              if (refusal !== undefined) {
                await reply(refusal);
                break;
              }
              envelopeSender = readAngleAddress(argument);
              await reply("250 2.1.0 OK");
              break;
            }
            case "RCPT":
              envelopeRecipients.push(readAngleAddress(argument));
              await reply("250 2.1.5 OK");
              break;
            case "DATA":
              readingData = true;
              await reply("354 End data with <CR><LF>.<CR><LF>");
              break;
            case "RSET":
              envelopeSender = null;
              envelopeRecipients = [];
              await reply("250 2.0.0 OK");
              break;
            case "NOOP":
              await reply("250 2.0.0 OK");
              break;
            case "QUIT":
              await reply("221 2.0.0 Bye");
              connection.close();
              return;
            default:
              await reply("502 5.5.2 Command not recognized");
          }
        }
      }
    } catch {
      // The client went away.
    } finally {
      openConnections.delete(connection);
      try {
        connection.close();
      } catch {
        // Already closed.
      }
    }
  };

  const acceptLoop = (async () => {
    try {
      for await (const connection of listener) handleConnection(connection);
    } catch {
      // The listener was closed.
    }
  })();

  return {
    hostName: "127.0.0.1",
    port: (listener.addr as Deno.NetAddr).port,
    receivedEmails,
    queuedRefusals,
    waitForEmails: (emailCount, timeoutMilliseconds = 30_000) =>
      new Promise((resolveWait, rejectWait) => {
        const check = () => {
          if (receivedEmails.length < emailCount) return false;
          clearTimeout(timeout);
          arrivalListeners.delete(listenerEntry);
          resolveWait(receivedEmails.slice(0, emailCount));
          return true;
        };
        const listenerEntry = () => {
          check();
        };
        const timeout = setTimeout(() => {
          arrivalListeners.delete(listenerEntry);
          rejectWait(
            new Error(`Expected ${emailCount} emails, received ${receivedEmails.length}.`),
          );
        }, timeoutMilliseconds);
        arrivalListeners.add(listenerEntry);
        check();
      }),
    stop: async () => {
      listener.close();
      for (const connection of openConnections) {
        try {
          connection.close();
        } catch {
          // Already closed.
        }
      }
      await acceptLoop;
    },
  };
}

export interface EmailPart {
  contentType: string;
  body: string;
}

/**
 * The headers and decoded text parts of a received message: enough for a test to read a
 * `multipart/alternative` email with quoted-printable or base64 parts.
 */
export function readEmail(
  rawMessage: string,
): { headers: Map<string, string>; parts: EmailPart[] } {
  const [headerText, ...bodyParts] = rawMessage.split("\r\n\r\n");
  const headers = parseHeaders(headerText);
  const body = bodyParts.join("\r\n\r\n");
  return { headers, parts: readParts(headers, body) };
}

function parseHeaders(headerText: string): Map<string, string> {
  const headers = new Map<string, string>();
  // A header continues on lines that start with white space.
  for (const headerLine of headerText.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const colonIndex = headerLine.indexOf(":");
    if (colonIndex === -1) continue;
    headers.set(
      headerLine.slice(0, colonIndex).trim().toLowerCase(),
      decodeEncodedWords(headerLine.slice(colonIndex + 1).trim()),
    );
  }
  return headers;
}

/** `=?UTF-8?Q?…?=` and `=?UTF-8?B?…?=`, as headers carry text that is not ASCII. */
function decodeEncodedWords(headerValue: string): string {
  return headerValue.replace(
    /=\?([^?]+)\?([QqBb])\?([^?]*)\?=\s*(?==\?)?/g,
    (_, _charset, kind, text) =>
      kind.toUpperCase() === "B"
        ? decodeBase64(text)
        : decodeQuotedPrintable(text.replace(/_/g, " ")),
  );
}

function decodeQuotedPrintable(encoded: string): string {
  const withoutSoftBreaks = encoded.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let index = 0; index < withoutSoftBreaks.length; index++) {
    const char = withoutSoftBreaks[index];
    const hexDigits = withoutSoftBreaks.slice(index + 1, index + 3);
    if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(hexDigits)) {
      bytes.push(parseInt(hexDigits, 16));
      index += 2;
    } else {
      bytes.push(...textEncoder.encode(char));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function readParts(headers: Map<string, string>, body: string): EmailPart[] {
  const contentType = headers.get("content-type") ?? "text/plain";
  const boundary = /boundary="?([^";]+)"?/.exec(contentType)?.[1];
  if (contentType.startsWith("multipart/") && boundary !== undefined) {
    return body.split(`--${boundary}`).slice(1, -1).flatMap((section) => {
      const [partHeaderText, ...partBody] = section.replace(/^\r\n/, "").split("\r\n\r\n");
      return readParts(
        parseHeaders(partHeaderText),
        partBody.join("\r\n\r\n").replace(/\r\n$/, ""),
      );
    });
  }
  const transferEncoding = (headers.get("content-transfer-encoding") ?? "7bit").toLowerCase();
  const decodedBody = transferEncoding === "quoted-printable"
    ? decodeQuotedPrintable(body)
    : transferEncoding === "base64"
    ? decodeBase64(body.replace(/\s/g, ""))
    : body;
  return [{ contentType: contentType.split(";")[0].trim(), body: decodedBody }];
}
