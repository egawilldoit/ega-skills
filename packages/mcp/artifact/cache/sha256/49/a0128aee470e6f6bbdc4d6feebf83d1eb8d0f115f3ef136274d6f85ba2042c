# UI verification recipes

Generic recipes for driving a UI when the repository has no harness of its own. Replace `PORT`, `APP_ROOT_SELECTOR`, and any role or name with values discovered from the current repository. Never copy selectors or ports from another repository.

## Generic web harness

Use the repository's installed browser tooling when possible. A minimal one-off probe with Playwright:

```javascript
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto("http://127.0.0.1:PORT");
await page.getByRole("button", { name: /submit/i }).click();
await page.screenshot({ path: "/tmp/ui-harness-after.png", fullPage: true });
await browser.close();
```

Do not add Playwright as a project dependency for the probe unless the user asks. Prefer existing dev dependencies or browser tooling already in the environment.

## Generic CDP harness

For Electron or a Chromium app launched with `--remote-debugging-port=DEBUG_PORT`, connect over CDP:

```javascript
import { chromium } from "playwright";

const browser = await chromium.connectOverCDP("http://127.0.0.1:DEBUG_PORT");
const pages = browser.contexts().flatMap((context) => context.pages());
let page;
for (const candidate of pages) {
  if (await candidate.locator("APP_ROOT_SELECTOR").count()) {
    page = candidate;
    break;
  }
}
if (!page) {
  console.log(
    await Promise.all(
      pages.map(async (p) => ({ title: await p.title(), url: p.url() })),
    ),
  );
  throw new Error("No matching app page found");
}

await page.screenshot({ path: "/tmp/ui-harness-cdp.png", fullPage: true });
await browser.close();
```

Replace `APP_ROOT_SELECTOR` with a stable marker from the current repository, such as a root app node, a landmark, or a product-specific `data-*` attribute.

## Page selection

When multiple app windows or tabs share a debug port:

- Prefer a positive marker for the surface under test, such as an app root selector.
- Use a negative marker to avoid the wrong surface when necessary.
- If no page matches, list available page titles and URLs instead of guessing.

## CDP capability surface

Use raw CDP only when higher-level browser APIs are insufficient.

- Performance: CPU profiles, traces, paint flashing, FPS meter, layout shift inspection.
- Memory: heap snapshots and forced GC for leak investigations.
- Network: request blocking, throttling, cache disablement, request and response logs.
- Rendering: viewport changes, color scheme emulation, reduced motion, accessibility checks.
- Debugging: console streaming, exception capture, DOM snapshots.

## Evidence capture

```javascript
await page.screenshot({ path: "artifacts/viewport.png" });
await page.screenshot({ path: "artifacts/full.png", fullPage: true });
const aria = await page.locator("body").ariaSnapshot();
await fs.writeFile("artifacts/page.aria.yml", aria);
```

Keep artifacts in a directory the workflow names, and keep them after cleanup. For a visual diff, capture a baseline from the pre-change state with the same viewport, device scale, and fonts as the treatment, then compare.

## Accessibility checks

Prefer the accessibility tree over raw DOM. Assert by role and accessible name. When a change is specifically about accessibility, capture an accessibility snapshot before and after and compare the two.
