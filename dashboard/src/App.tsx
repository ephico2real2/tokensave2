import type { ComponentChildren } from 'preact';
import { useEffect, useErrorBoundary, useMemo, useRef, useState } from 'preact/hooks';
import { modelsApi } from './api/models';
import type { Scope } from './api/params';
import { reposApi } from './api/repos';
import { statusApi } from './api/status';
import { useAutoRefresh } from './api/useAutoRefresh';
import { RefreshContext, dataOf, useDataset } from './api/useResource';
import { reloadPage } from './reload';
import { AppHeader } from './components/AppHeader';
import {
  DEFAULT_THEME,
  clampCustom,
  defaultCustom,
  localToday,
  parseUrlState,
  repoChoices,
  readStoredTheme,
  serializeUrlState,
  storeTheme,
  type Filters,
  type Range,
  type Tab,
  type Theme,
  type UrlState,
} from './state';
import { Agents } from './tabs/Agents';
import { Models } from './tabs/Models';
import { Overview } from './tabs/Overview';
import { Repos } from './tabs/Repos';
import { Savings } from './tabs/Savings';
import { Sources } from './tabs/Sources';
import { EFFORTS, TOOLS } from './types';

/** Sets <html data-theme>, which tokens.css reads; Auto is resolved there, live, by the OS. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function App() {
  // The interval comes from /api/status, which is itself a dataset under this provider.
  const [refreshSeconds, setRefreshSeconds] = useState(0);
  const refresh = useAutoRefresh(refreshSeconds);
  return (
    <RefreshContext.Provider value={refresh}>
      <Page onRefreshSeconds={setRefreshSeconds} updatedAt={refresh.updatedAt} refreshFailed={refresh.failed} />
    </RefreshContext.Provider>
  );
}

function Page({
  onRefreshSeconds,
  updatedAt,
  refreshFailed,
}: {
  onRefreshSeconds: (seconds: number) => void;
  updatedAt: number | null;
  refreshFailed: boolean;
}) {
  const now = Date.now();
  const today = localToday(new Date(now));
  const [state, setState] = useState<UrlState>(() => parseUrlState(window.location.search, today));
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme() ?? DEFAULT_THEME);

  useEffect(() => applyTheme(theme), [theme]);

  // The URL always shows the current state, so a link or a refresh keeps it.
  useEffect(() => {
    const search = serializeUrlState(state);
    if (search !== window.location.search) {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}${window.location.hash}`);
    }
  }, [state]);

  const status = useDataset(statusApi, undefined);
  const pageVersion = useRef<string | null>(null);
  const statusData = dataOf(status);
  useEffect(() => {
    if (!statusData) return;
    onRefreshSeconds(statusData.refreshSeconds);
    // A new build started under this open tab: its script is the old one, so load the new one.
    if (pageVersion.current !== null && pageVersion.current !== statusData.pageVersion) reloadPage();
    pageVersion.current = statusData.pageVersion;
  }, [statusData, onRefreshSeconds]);

  // A workspace counts once the server lists it, so a link naming one this machine doesn't have
  // falls back to all workspaces, as any other invalid value in the URL does.
  const workspace = statusData?.workspaces.includes(state.workspace) ? state.workspace : '';
  useEffect(() => {
    if (statusData && state.workspace && !workspace) setState((s) => ({ ...s, workspace: '' }));
  }, [statusData, state.workspace, workspace]);

  const scope: Scope = useMemo(
    () => ({
      range: state.range,
      from: state.from,
      to: state.to,
      workspace,
      repo: state.repo,
      tool: state.tool,
      model: state.model,
      effort: state.effort,
    }),
    [state.range, state.from, state.to, workspace, state.repo, state.tool, state.model, state.effort],
  );

  // Filter choices: the repos of the workspace and the models in the range. Their endpoints don't
  // take the repo or model filter, so picking one never shrinks its own list. The Repos and
  // Models tabs draw from these same requests.
  const repos = useDataset(reposApi, scope);
  const models = useDataset(modelsApi, scope);
  const repoOptions = repoChoices(dataOf(repos)?.repos ?? []);
  const modelOptions = (dataOf(models)?.rows ?? []).map((r) => r.model);

  const update = (patch: Partial<UrlState>) => setState((s) => ({ ...s, ...patch }));

  return (
    <div class="ts-app">
      <AppHeader
        state={state}
        theme={theme}
        today={today}
        status={status.resource}
        onRetryStatus={status.retry}
        updatedAt={updatedAt}
        refreshFailed={refreshFailed}
        repoOptions={repoOptions}
        modelOptions={modelOptions}
        onTheme={(t) => {
          setTheme(t);
          storeTheme(t);
        }}
        onTab={(tab: Tab) => update({ tab })}
        onRange={(range: Range) =>
          update(range === 'custom' && state.range !== 'custom' ? { range, ...defaultCustom(today) } : { range })
        }
        onCustom={(from, to) => update(clampCustom(from, to, today))}
        onFilter={(key: keyof Filters, value: string) => update(filterPatch(key, value))}
      />
      <main class="ts-main">
        <TabBoundary key={state.tab}>
          {state.tab === 'overview' && <Overview scope={scope} />}
          {state.tab === 'agents' && <Agents scope={scope} />}
          {state.tab === 'models' && <Models scope={scope} models={models} />}
          {state.tab === 'repos' && <Repos repos={repos} now={now} />}
          {state.tab === 'savings' && <Savings scope={scope} />}
          {state.tab === 'sources' && <Sources now={now} />}
        </TabBoundary>
      </main>
    </div>
  );
}

/**
 * Draws a tab, or names the error when its data doesn't fit the types (the responses are not
 * checked at run time). Without it, the throw escapes Preact's render queue as an unhandled
 * rejection and every section of the tab stays on "Loading…". Retry draws the tab again, which
 * asks for its data again.
 */
function TabBoundary({ children }: { children: ComponentChildren }) {
  const [error, reset] = useErrorBoundary();
  if (!error) return <>{children}</>;
  return (
    <div class="ts-state ts-state--error" role="alert">
      <span>Couldn't draw this tab. {error instanceof Error ? error.message : String(error)}</span>
      <button type="button" class="ts-retry" onClick={reset}>
        Retry
      </button>
    </div>
  );
}

/** A filter change, with the closed lists (tool, effort) checked like the URL is. */
function filterPatch(key: keyof Filters, value: string): Partial<Filters> {
  if (key === 'tool') return { tool: TOOLS.find((t) => t === value) ?? '' };
  if (key === 'effort') return { effort: EFFORTS.find((e) => e === value) ?? '' };
  return { [key]: value };
}
