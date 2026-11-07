import { expect, test, type Page } from '@playwright/test';
import { EFFORTS, TOOLS } from '../../src/types';
import { RANGES, TABS, THEMES } from '../../src/state';

// Every state the page's URL and controls can reach, against the real server and data:
// a failed request, a script error, a failed section, a leftover placeholder or a sideways
// scroll fails the case. Run with `npm run sweep`, with the dashboard running.
const WIDTHS = [390, 820, 1440];
const TODAY = new Date().toISOString().slice(0, 10);

// How long the network must stay quiet before a screen counts as finished. A click changes the
// page after its next paint, and only then do its requests start.
const QUIET_MS = 300;

type Problems = string[];

const inFlight = new WeakMap<Page, number>();

/** Records what the page gets wrong from here on. */
function watch(page: Page): Problems {
  const problems: Problems = [];
  inFlight.set(page, 0);
  const add = (n: number) => inFlight.set(page, (inFlight.get(page) ?? 0) + n);
  page.on('request', () => add(1));
  page.on('requestfinished', () => add(-1));
  page.on('requestfailed', () => add(-1));
  page.on('pageerror', (e) => problems.push(`script error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`${r.status()} ${new URL(r.url()).pathname}${new URL(r.url()).search}`);
  });
  page.on('requestfailed', (r) => {
    if (r.failure()?.errorText !== 'net::ERR_ABORTED') problems.push(`request failed: ${r.url()}`);
  });
  return problems;
}

/**
 * Waits until the requests of the last action have answered. `networkidle` can't do this: once a
 * page has reached it, it returns at once, and a click would be checked before anything changed.
 */
async function settled(page: Page) {
  let quietSince = Date.now();
  while (Date.now() - quietSince < QUIET_MS) {
    await page.waitForTimeout(25);
    if ((inFlight.get(page) ?? 0) > 0) quietSince = Date.now();
  }
  await expect(page.locator('[role="status"]', { hasText: /^Loading/ })).toHaveCount(0);
}

/** What must hold on every screen. */
async function screenProblems(page: Page): Promise<Problems> {
  return page.evaluate(() => {
    const out: string[] = [];
    const text = document.body.innerText;
    if (text.includes("Couldn't load")) out.push('a section failed to load');
    for (const leftover of ['undefined', 'NaN', '[object Object]', '{{']) {
      if (text.includes(leftover)) out.push(`leftover text: ${leftover}`);
    }
    const width = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > width) out.push(`scrolls sideways: ${document.documentElement.scrollWidth} > ${width}`);
    const app = document.querySelector('.ts-app')?.getBoundingClientRect().height ?? 0;
    if (app < window.innerHeight) out.push('the background stops short of the screen');
    if (document.querySelectorAll('nav [aria-current="page"]').length !== 1) out.push('no single current tab');
    return out;
  });
}

async function check(page: Page, problems: Problems, what: string, failures: string[]) {
  await settled(page);
  const found = [...problems.splice(0), ...(await screenProblems(page))];
  if (found.length) failures.push(`${what}: ${[...new Set(found)].join('; ')}`);
}

function report(failures: string[]) {
  expect(failures.length, `\n${failures.slice(0, 40).join('\n')}\n`).toBe(0);
}

for (const { width, height } of WIDTHS.map((w) => ({ width: w, height: w === 390 ? 844 : 900 }))) {
  for (const { id: tab } of TABS) {
    test(`${tab} at ${width} px: every theme and range`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      const problems = watch(page);
      const failures: string[] = [];
      for (const { id: theme } of THEMES) {
        await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
        for (const { id: range } of RANGES) {
          const dates = range === 'custom' ? `&from=${TODAY}&to=${TODAY}` : '';
          await page.goto(`/?tab=${tab}&range=${range}${dates}`);
          await check(page, problems, `${tab} ${theme} ${range}`, failures);
        }
      }
      report(failures);
    });
  }
}

test('every repo, on every tab', async ({ page, request }) => {
  test.setTimeout(1_800_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const problems = watch(page);
  const failures: string[] = [];
  const { repos } = (await (await request.get('/api/repos?range=90')).json()) as { repos: { path: string }[] };
  expect(repos.length).toBeGreaterThan(0);
  for (const { path } of repos) {
    for (const { id: tab } of TABS) {
      await page.goto(`/?tab=${tab}&range=90&repo=${encodeURIComponent(path)}`);
      await check(page, problems, `${tab} ${path}`, failures);
    }
  }
  report(failures);
});

test('every choice of each filter, one at a time and through its control', async ({ page }) => {
  test.setTimeout(1_800_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const problems = watch(page);
  const failures: string[] = [];
  await page.goto('/?range=90');
  await settled(page);
  for (const { name, key } of [
    { name: 'Repo', key: 'repo' },
    { name: 'Agent tool', key: 'tool' },
    { name: 'Model', key: 'model' },
    { name: 'Effort', key: 'effort' },
  ]) {
    const select = page.getByRole('combobox', { name });
    const values = await select.evaluate((s: HTMLSelectElement) => [...s.options].map((o) => o.value));
    expect(values.length).toBeGreaterThan(1);
    for (const value of values) {
      await select.selectOption(value);
      await check(page, problems, `${name}=${value || 'all'}`, failures);
      expect(new URL(page.url()).searchParams.get(key) ?? '').toBe(value);
    }
    await select.selectOption('');
    await settled(page);
  }
  report(failures);
});

test('every tool crossed with every effort and every tab', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const problems = watch(page);
  const failures: string[] = [];
  for (const tool of TOOLS) {
    for (const effort of EFFORTS) {
      for (const { id: tab } of TABS) {
        await page.goto(`/?tab=${tab}&range=90&tool=${encodeURIComponent(tool)}&effort=${effort}`);
        await check(page, problems, `${tab} ${tool} ${effort}`, failures);
      }
    }
  }
  report(failures);
});

test('the sweep sees a failure that arrives after a click', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const problems = watch(page);
  const failures: string[] = [];
  await page.goto('/');
  await settled(page);
  await page.route(/\/api\/.*range=7/, async (route) => {
    await new Promise((done) => setTimeout(done, 1000));
    await route.fulfill({ status: 500, json: { error: 'control' } });
  });
  await page.getByRole('button', { name: '7 days', exact: true }).click();
  await check(page, problems, 'control', failures);
  expect(failures.join()).toContain('500');
});

test('the controls change the page, and the URL and a reload keep it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const problems = watch(page);
  const failures: string[] = [];
  await page.goto('/');
  await settled(page);
  for (const { id, label } of TABS) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await check(page, problems, `tab ${label}`, failures);
    await expect(page.locator('nav [aria-current="page"]')).toHaveText(label);
    if (id !== 'overview') expect(new URL(page.url()).searchParams.get('tab')).toBe(id);
  }
  for (const { id, label } of THEMES) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', id);
    await page.reload();
    await settled(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', id);
  }
  for (const { id, label } of RANGES) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await check(page, problems, `range ${label}`, failures);
    expect(new URL(page.url()).searchParams.get('range') ?? '30').toBe(id);
  }
  report(failures);
});

test('invalid links open on the defaults, with no failed request', async ({ page }) => {
  const problems = watch(page);
  const failures: string[] = [];
  for (const search of ['?tab=nope', '?range=999', '?range=custom&from=bad&to=bad', '?range=custom&from=2999-01-01&to=2999-01-02', '?repo=not-a-path', '?tool=nope', '?effort=nope', '?repo=%2Fno%2Fsuch%2Frepo', '?model=no-such-model', '?workspace=%2Fno%2Fsuch']) {
    await page.goto(`/${search}`);
    await check(page, problems, search, failures);
  }
  report(failures);
});

test('the keyboard reaches every control of the header, and the phone filter sheet opens and closes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const problems = watch(page);
  const failures: string[] = [];
  await page.goto('/');
  await settled(page);
  const button = page.locator('.ts-filterbtn');
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await check(page, problems, 'filter sheet open', failures);
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await page.setViewportSize({ width: 1440, height: 900 });
  const controls = await page.locator('header button:visible, header select:visible, header input:visible, header a[href]:visible').count();
  const reached = new Set<string>();
  await page.locator('body').focus();
  for (let i = 0; i < controls + 5; i++) {
    await page.keyboard.press('Tab');
    reached.add(await page.evaluate(() => {
      const e = document.activeElement as HTMLElement | null;
      return e && e.closest('header') ? `${e.tagName}:${e.getAttribute('aria-label') ?? e.textContent?.slice(0, 20)}` : '';
    }));
  }
  reached.delete('');
  if (reached.size < controls) failures.push(`the keyboard reached ${reached.size} of ${controls} header controls`);
  report(failures);
});
