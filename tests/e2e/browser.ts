/**
 * Drives the web UI in headless Chromium for the browser tests. The browser comes from
 * `deno task install:browser`, which installs the build that the pinned playwright-core expects.
 */
import { assert, assertEquals } from "@std/assert";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Locator,
  type Page,
} from "playwright-core";
import type { LocalAccount, RunningDeployment } from "./deployment.ts";

export async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch (error) {
    throw new Error(
      `Chromium could not start. Install it with \`deno task install:browser\`.\n${
        (error as Error).message
      }`,
    );
  }
}

export interface UiSession {
  page: Page;
  context: BrowserContext;
  /** Uncaught exceptions and console errors, which every test expects to stay empty. */
  pageErrors: string[];
  close(): Promise<void>;
}

interface OpenUiOptions {
  width: number;
  height?: number;
  /** The account signed in before the page loads; null opens the UI signed out. */
  account: LocalAccount | null;
  colorScheme?: "light" | "dark";
  path?: string;
}

export async function openUi(
  browser: Browser,
  deployment: RunningDeployment,
  { width, height = 900, account, colorScheme = "light", path = "/" }: OpenUiOptions,
): Promise<UiSession> {
  const context = await browser.newContext({
    baseURL: deployment.gatewayUrl,
    viewport: { width, height },
    colorScheme,
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
  });
  if (account !== null) {
    // The context's requests share its cookies, so the page starts signed in.
    const signInResponse = await context.request.post("/v1/sign-in", { data: account });
    assertEquals(signInResponse.status(), 200, await signInResponse.text());
  }
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    // An ended sign-in is an expected 401 that the browser logs as a failed resource.
    if (message.type() === "error" && !message.text().includes("401")) {
      pageErrors.push(`console error: ${message.text()}`);
    }
  });
  await page.goto(path);
  return { page, context, pageErrors, close: () => context.close() };
}

export async function waitForCondition(
  description: string,
  condition: () => Promise<boolean>,
  timeoutMilliseconds = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting until ${description}.`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

/** The trace table's column headings that are actually displayed, in order. */
export async function readVisibleColumnHeadings(page: Page): Promise<string[]> {
  const headings = page.locator(".trace-list-panel thead th");
  await headings.first().waitFor();
  const visibleHeadings: string[] = [];
  for (const heading of await headings.all()) {
    if (await heading.isVisible()) visibleHeadings.push((await heading.innerText()).trim());
  }
  return visibleHeadings.map((heading) => heading.toLowerCase());
}

/** Pixels by which the element's content is wider than the element itself. */
export async function measureHorizontalOverflow(locator: Locator): Promise<number> {
  return await locator.evaluate((element) => element.scrollWidth - element.clientWidth);
}

export async function assertNoHorizontalOverflow(page: Page, situation: string): Promise<void> {
  const pageOverflow = await measureHorizontalOverflow(page.locator("html"));
  assertEquals(pageOverflow, 0, `The page scrolls sideways ${situation}.`);
  const listScroll = page.locator(".trace-list-panel .table-scroll");
  if (await listScroll.count() > 0) {
    assertEquals(
      await measureHorizontalOverflow(listScroll),
      0,
      `The trace list scrolls sideways ${situation}.`,
    );
  }
}

/**
 * Forgets the console errors that the browser logs for failed requests with these statuses, for
 * steps that provoke an error response on purpose.
 */
export function forgetExpectedRequestFailures(uiSession: UiSession, statusCodes: number[]): void {
  const expectedErrors = uiSession.pageErrors.filter((pageError) =>
    statusCodes.some((statusCode) => pageError.includes(`status of ${statusCode}`))
  );
  for (const expectedError of expectedErrors) {
    uiSession.pageErrors.splice(uiSession.pageErrors.indexOf(expectedError), 1);
  }
}

export function assertNoPageErrors(uiSession: UiSession): void {
  assert(uiSession.pageErrors.length === 0, uiSession.pageErrors.join("\n"));
}

/** A computed CSS property; the function runs in the page, where `getComputedStyle` exists. */
export async function readComputedStyle(locator: Locator, propertyName: string): Promise<string> {
  return await locator.evaluate((element, cssProperty) => {
    const pageWindow = globalThis as unknown as {
      getComputedStyle(target: unknown): Record<string, string>;
    };
    return pageWindow.getComputedStyle(element)[cssProperty];
  }, propertyName);
}
