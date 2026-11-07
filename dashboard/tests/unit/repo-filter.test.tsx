import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/App';
import { fixtureFor } from '../fixtures/mockup';

const REPOS = [
  { name: 'portal', path: '/home/you/gitRepos/border/portal' },
  { name: 'main', path: '/home/you/gitRepos/a/main' },
  { name: 'main', path: '/home/you/gitRepos/b/main' },
].map((r) => ({ ...r, indexed: true, spentTokens: null, savedTokens: null, tools: [], lastActivity: null }));

/** Answers as the server does: `repo` must be absolute (src/dashboard/params.rs, parse_repo). */
function mockServer(): string[] {
  const refused: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://127.0.0.1:7311');
      const repo = url.searchParams.get('repo');
      if (repo !== null && !repo.startsWith('/')) {
        refused.push(`${url.pathname}${url.search}`);
        return new Response(JSON.stringify({ error: "`repo` must be a repo's absolute path, as /api/repos lists it", parameter: 'repo' }), {
          status: 400,
          statusText: 'Bad Request',
        });
      }
      const body = url.pathname === '/api/repos' ? { ...(fixtureFor(url.pathname, url.searchParams) as object), repos: REPOS } : fixtureFor(url.pathname, url.searchParams);
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return refused;
}

const open = (search: string) => {
  window.history.replaceState(null, '', `/${search}`);
  render(<App />);
};

const repoSelect = () => screen.getByRole('combobox', { name: /Repo/ }) as HTMLSelectElement;
const listed = () => waitFor(() => expect(repoSelect().options.length).toBeGreaterThan(REPOS.length));

describe('the repo filter', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('asks the server for the path of the repo picked, and the server accepts it', async () => {
    const refused = mockServer();
    open('');
    await listed();
    fireEvent.change(repoSelect(), { target: { value: '/home/you/gitRepos/border/portal' } });
    await waitFor(() => expect(window.location.search).toContain('repo=%2Fhome%2Fyou%2FgitRepos%2Fborder%2Fportal'));
    await waitFor(() => expect(screen.queryByText(/Couldn't load this section/)).toBeNull());
    expect(refused).toEqual([]);
    expect(repoSelect().selectedOptions[0]!.textContent).toBe('portal');
    expect(screen.getByRole('button', { name: /^Filters · portal, / })).toBeTruthy();
  });

  it('tells apart two repos with one name', async () => {
    mockServer();
    open('');
    await listed();
    const options = [...repoSelect().options].map((o) => [o.value, o.textContent]);
    expect(options).toEqual([
      ['', 'All repos'],
      ['/home/you/gitRepos/border/portal', 'portal'],
      ['/home/you/gitRepos/a/main', 'main · /home/you/gitRepos/a/main'],
      ['/home/you/gitRepos/b/main', 'main · /home/you/gitRepos/b/main'],
    ]);
  });

  it('opens an older link that names a repo by its bare name on all repos, with no failed section', async () => {
    const refused = mockServer();
    open('?repo=portal');
    await listed();
    expect(repoSelect().value).toBe('');
    expect(refused).toEqual([]);
    expect(screen.queryByText(/Couldn't load this section/)).toBeNull();
  });

  it('keeps a shared path that is no longer listed, under its last folder name', async () => {
    mockServer();
    open('?repo=%2Fhome%2Fyou%2Fold-repo');
    await listed();
    expect(repoSelect().value).toBe('/home/you/old-repo');
    expect(repoSelect().selectedOptions[0]!.textContent).toBe('old-repo');
  });
});
