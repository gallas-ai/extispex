import { useState } from "react";
import { ApiKeyField } from "./api-key/api-key-field.tsx";
import { readStoredApiKey, storeApiKey } from "./api-key/api-key-storage.ts";
import { TracesPage } from "./traces/traces-page.tsx";

export function App() {
  const [apiKey, setApiKey] = useState(readStoredApiKey);

  const updateApiKey = (nextApiKey: string) => {
    setApiKey(nextApiKey);
    storeApiKey(nextApiKey);
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-title">
          <span className="app-name">Extispex</span>
          <nav className="app-navigation" aria-label="Sections">
            <span className="navigation-item navigation-item-active">Traces</span>
          </nav>
        </div>
        <ApiKeyField apiKey={apiKey} onApiKeyChange={updateApiKey} />
      </header>
      <main className="app-content">
        {apiKey === "" ? <MissingApiKeyNotice /> : <TracesPage apiKey={apiKey} />}
      </main>
    </div>
  );
}

function MissingApiKeyNotice() {
  return (
    <section className="empty-state">
      <h1>Enter an API key to see traces</h1>
      <p>
        The key decides which Project you see. The local image uses{" "}
        <code>local-development-key</code> unless <code>STATIC_API_KEYS</code> is set.
      </p>
    </section>
  );
}
