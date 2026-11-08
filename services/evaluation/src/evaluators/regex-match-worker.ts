/**
 * Runs one user-supplied regular expression. It lives in a Web Worker because a slow pattern can
 * block a thread for a very long time, and only another thread can stop it by terminating this one.
 */
/// <reference no-default-lib="true" />
/// <reference lib="deno.worker" />

self.onmessage = (messageEvent: MessageEvent<{ pattern: string; flags: string; text: string }>) => {
  const { pattern, flags, text } = messageEvent.data;
  self.postMessage({ matched: new RegExp(pattern, flags).test(text) });
};

self.postMessage({ ready: true });
