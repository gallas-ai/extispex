import { useState } from "react";
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation } from "react-router";
import { ApiKeyMenu } from "./api-key/api-key-menu.tsx";
import { readStoredApiKey, storeApiKey } from "./api-key/api-key-storage.ts";
import { ConnectProject } from "./api-key/connect-project.tsx";
import { PromptComparisonPage } from "./prompts/prompt-comparison-page.tsx";
import { NewPromptPage, NewPromptVersionPage } from "./prompts/prompt-editor-page.tsx";
import { PromptPage } from "./prompts/prompt-page.tsx";
import { NEW_PROMPT_PATH, PromptsPage } from "./prompts/prompts-page.tsx";
import { ThemeSwitcher } from "./theme/theme-switcher.tsx";
import { TracesPage } from "./traces/traces-page.tsx";
import { ActivityIcon, BrandMark, InboxIcon, PromptIcon } from "./ui/icons.tsx";

export function App() {
  return (
    // Without transitions, a URL change is applied before the next key press is handled, so
    // keyboard selection such as `j`, `k` and the arrow keys always starts from the current state.
    <BrowserRouter useTransitions={false}>
      <AppShell />
    </BrowserRouter>
  );
}

function AppShell() {
  const [apiKey, setApiKey] = useState(readStoredApiKey);
  const { pathname } = useLocation();

  const updateApiKey = (nextApiKey: string) => {
    setApiKey(nextApiKey);
    storeApiKey(nextApiKey);
  };
  const disconnect = () => updateApiKey("");
  const isConnected = apiKey !== "";
  // Creating a prompt lives outside /prompts/ so that a prompt may be named "new".
  const isInPrompts = pathname.startsWith("/prompts") || pathname === NEW_PROMPT_PATH;
  const pageProps = { apiKey, onDisconnect: disconnect };

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="top-bar-start">
          <Link className="brand" to="/" aria-label="Extispex home">
            <BrandMark size={26} />
            <span className="brand-name">Extispex</span>
          </Link>
          {isConnected && (
            <nav className="primary-navigation" aria-label="Sections">
              <NavLink className="navigation-link" to="/traces">
                <ActivityIcon size={15} />
                <span className="navigation-link-text">Traces</span>
              </NavLink>
              <Link
                className="navigation-link"
                to="/prompts"
                aria-current={isInPrompts ? "page" : undefined}
              >
                <PromptIcon size={15} />
                <span className="navigation-link-text">Prompts</span>
              </Link>
            </nav>
          )}
        </div>
        <div className="top-bar-end">
          {isConnected && <ApiKeyMenu apiKey={apiKey} onApiKeyChange={updateApiKey} />}
          <ThemeSwitcher />
        </div>
      </header>
      <main className="app-content">
        {!isConnected ? <ConnectProject onConnect={updateApiKey} /> : (
          <Routes>
            <Route path="/" element={<RedirectToTraces />} />
            <Route path="/traces" element={<TracesPage {...pageProps} />} />
            <Route path="/prompts" element={<PromptsPage {...pageProps} />} />
            <Route path={NEW_PROMPT_PATH} element={<NewPromptPage {...pageProps} />} />
            <Route path="/prompts/:promptName" element={<PromptPage {...pageProps} />} />
            <Route
              path="/prompts/:promptName/versions/new"
              element={<NewPromptVersionPage {...pageProps} />}
            />
            <Route
              path="/prompts/:promptName/compare"
              element={<PromptComparisonPage {...pageProps} />}
            />
            <Route path="*" element={<PageNotFound />} />
          </Routes>
        )}
      </main>
    </div>
  );
}

/** Keeps links to the first version of the UI, which showed traces at `/?sessionId=…`, working. */
function RedirectToTraces() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: "/traces", search }} replace />;
}

function PageNotFound() {
  return (
    <div className="page">
      <div className="empty-state">
        <span className="empty-state-icon">
          <InboxIcon size={22} />
        </span>
        <h1 className="empty-state-title">This page does not exist</h1>
        <p>The link may be outdated.</p>
        <Link className="button button-secondary" to="/traces">Go to Traces</Link>
      </div>
    </div>
  );
}
