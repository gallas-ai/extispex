---
status: accepted
---

# Test the web UI with Playwright and layout rules instead of screenshots

The web UI is tested in headless Chromium driven by `playwright-core`, from ordinary `Deno.test`
files in `tests/e2e`. The tests reuse `startDeployment`, so they run against all-in-one, separate
services and the container image, like every other e2e test. They send their own traces over OTLP
with fresh Session IDs, so a shared database does not affect them.

The tests check rules rather than pixels: which trace table columns show at which width, that the
page never scrolls sideways at any window width from 360px to 2,000px, that an open trace takes most
of the width beside the list and becomes a drawer below 1,100px, and the main flows such as opening
a trace, the span tree's keyboard controls, filtering by Session and the theme switch. Before they
were merged, five deliberate CSS regressions were introduced one at a time; the tests caught each
one that changed what a user sees. They also found a real one: the trace list scrolled sideways
between 940px and 1,180px when Session IDs were as long as real applications make them.

## Considered Options

- **Screenshot comparison (rejected):** It catches every visual change, including colours and
  spacing that rules miss. It was rejected because Chromium renders fonts differently on macOS and
  on the Linux CI runners, so the reference images would only match inside one pinned container
  image, and every intended design change would need new images reviewed by eye.
- **`@playwright/test` as the runner (rejected):** It brings `expect` with automatic retries, traces
  and parallel workers. It was rejected because the repository runs every test with `deno test`, and
  a second runner would need its own configuration, reporters and CI step.
- **Puppeteer or WebDriver (rejected):** Both work, but Playwright's locators by role and label
  match how the UI is built for accessibility, and its browser download is pinned to the library
  version.

## Consequences

- `playwright-core` is pinned to an exact version, because each version expects one Chromium build.
  `deno task install:browser` installs that build, and CI runs it with `--with-deps` before the e2e
  tests.
- Without `expect`, the tests wait with `waitForCondition` and Playwright's `waitFor`.
- Colours, spacing and typography are not checked. A change to them needs a look at the page, for
  example with a screenshot in the pull request.
- A new layout rule, such as a column that gives way at some width, gets a test step that states it.
