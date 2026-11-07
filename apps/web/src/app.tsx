import { useState } from "react";
import { ApiKeyMenu } from "./api-key/api-key-menu.tsx";
import { readStoredApiKey, storeApiKey } from "./api-key/api-key-storage.ts";
import { ConnectProject } from "./api-key/connect-project.tsx";
import { ThemeSwitcher } from "./theme/theme-switcher.tsx";
import { TracesPage } from "./traces/traces-page.tsx";
import { ActivityIcon, BrandMark } from "./ui/icons.tsx";

export function App() {
  const [apiKey, setApiKey] = useState(readStoredApiKey);

  const updateApiKey = (nextApiKey: string) => {
    setApiKey(nextApiKey);
    storeApiKey(nextApiKey);
  };

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="top-bar-start">
          <a className="brand" href="/" aria-label="Extispex home">
            <BrandMark size={26} />
            <span className="brand-name">Extispex</span>
          </a>
          {apiKey !== "" && (
            <nav className="primary-navigation" aria-label="Sections">
              <a className="navigation-link" href="/" aria-current="page">
                <ActivityIcon size={15} />
                Traces
              </a>
            </nav>
          )}
        </div>
        <div className="top-bar-end">
          {apiKey !== "" && <ApiKeyMenu apiKey={apiKey} onApiKeyChange={updateApiKey} />}
          <ThemeSwitcher />
        </div>
      </header>
      <main className="app-content">
        {apiKey === ""
          ? <ConnectProject onConnect={updateApiKey} />
          : <TracesPage apiKey={apiKey} onDisconnect={() => updateApiKey("")} />}
      </main>
    </div>
  );
}
