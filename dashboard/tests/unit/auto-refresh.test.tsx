import { act, cleanup, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/App';
import { reloadPage } from '../../src/reload';
import { M1 as figure } from '../../src/format';
import { fixtureFor } from '../fixtures/mockup';

vi.mock('../../src/reload', () => ({ reloadPage: vi.fn() }));

type Server = { calls: string[]; down: boolean; pageVersion: string; spent: number; refreshSeconds: number };

function mockServer(over: Partial<Server> = {}): Server {
  const server: Server = { calls: [], down: false, pageVersion: 'one', spent: 1_500_000, refreshSeconds: 60, ...over };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://127.0.0.1:7311');
      server.calls.push(url.pathname);
      if (server.down) throw new TypeError('Failed to fetch');
      let body = fixtureFor(url.pathname, url.searchParams) as object;
      if (url.pathname === '/api/status') body = { ...body, refreshSeconds: server.refreshSeconds, pageVersion: server.pageVersion };
      if (url.pathname === '/api/summary') body = { ...body, spentTokens: server.spent };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return server;
}

const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
};
const step = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
/** Moves the clock, then lets the requests it started finish. `act` holds renders until it ends, and reading a Response body takes real turns of the event loop, so each turn gets its own `act`. */
const advance = async (seconds: number) => {
  await step(seconds * 1000);
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    await step(5);
  }
};
const count = (server: Server, path: string) => server.calls.filter((c) => c === path).length;
const start = async () => {
  render(<App />);
  await advance(0.01);
};

describe('the page refreshes itself', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    window.history.replaceState(null, '', '/');
    vi.mocked(reloadPage).mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setHidden(false);
  });

  it('asks again at the interval the server names, and shows the new figure with no loading state', async () => {
    const server = mockServer();
    await start();
    expect(count(server, '/api/summary')).toBe(1);
    expect(document.body.textContent).toContain(figure(1_500_000));
    server.spent = 2_500_000;
    let loading = false;
    const seen = new MutationObserver(() => {
      if (/Loading/.test(document.body.textContent ?? '')) loading = true;
    });
    seen.observe(document.body, { childList: true, subtree: true, characterData: true });
    await advance(60);
    seen.disconnect();
    expect(count(server, '/api/summary')).toBe(2);
    expect(document.body.textContent).toContain(figure(2_500_000));
    expect(loading).toBe(false);
  });

  it('does not ask while the tab is hidden, and asks at once when it returns', async () => {
    const server = mockServer();
    await start();
    act(() => setHidden(true));
    await advance(300);
    expect(count(server, '/api/summary')).toBe(1);
    act(() => setHidden(false));
    await advance(0);
    expect(count(server, '/api/summary')).toBe(2);
  });

  it('does not ask again when the server turns refresh off', async () => {
    const server = mockServer({ refreshSeconds: 0 });
    await start();
    await advance(600);
    expect(count(server, '/api/summary')).toBe(1);
  });

  it('keeps the figures when a refresh fails, says so, and recovers by itself', async () => {
    const server = mockServer();
    await start();
    expect(document.body.textContent).toContain(figure(1_500_000));
    server.down = true;
    await advance(60);
    expect(document.body.textContent).toContain(figure(1_500_000));
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
    expect(document.querySelector('.ts-refresh-failed')?.textContent).toMatch(/refresh failed, figures from/);
    server.down = false;
    server.spent = 3_500_000;
    await advance(60);
    expect(document.body.textContent).toContain(figure(3_500_000));
    expect(document.querySelector('.ts-refresh-failed')).toBeNull();
  });

  it('says when the figures were updated', async () => {
    mockServer();
    await start();
    expect(document.querySelector('.ts-server')?.textContent).toMatch(/updated \d/);
  });

  it('reloads the page when the server runs a new build, and only then', async () => {
    const server = mockServer();
    await start();
    await advance(60);
    expect(reloadPage).not.toHaveBeenCalled();
    server.pageVersion = 'two';
    await advance(60);
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });
});
