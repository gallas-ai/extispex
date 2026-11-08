import type { Dataset } from "@extispex/contracts";
import { type FormEvent, useCallback, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { ApiCredentials } from "../api/api-request.ts";
import { createDataset, listDatasets } from "../api/evaluation-api.ts";
import { useCanEditProject } from "../sign-in/access-context.ts";
import { formatRelativeTime } from "../traces/trace-formatting.ts";
import { AlertIcon, DatasetIcon, PlusIcon } from "../ui/icons.tsx";
import { LoadError } from "../ui/load-error.tsx";
import { useApiResource } from "../ui/use-api-resource.ts";
import { useNow } from "../ui/use-now.ts";
import { datasetPagePath } from "./dataset-paths.ts";

interface DatasetsPageProps {
  credentials: ApiCredentials;
  onSignInRequired: () => void;
}

export function DatasetsPage({ credentials, onSignInRequired }: DatasetsPageProps) {
  const canEdit = useCanEditProject();
  const loadDatasets = useCallback(() => listDatasets(credentials), [credentials]);
  const [datasetsState, reloadDatasets] = useApiResource(loadDatasets);

  return (
    <div className="page page-constrained">
      <div className="page-header">
        <div className="page-heading">
          <h1>Datasets</h1>
          <p className="page-subtitle">
            Named collections of Test Cases that an Evaluation Run executes.
          </p>
        </div>
      </div>
      {canEdit && <NewDatasetForm credentials={credentials} />}
      <section className="panel" aria-label="Dataset list">
        {datasetsState.status === "loading" && <div className="panel-loading" aria-busy="true" />}
        {datasetsState.status === "failed" && (
          <LoadError
            subject="Datasets"
            message={datasetsState.message}
            isSignInRequired={datasetsState.isSignInRequired}
            onRetry={reloadDatasets}
            onSignInRequired={onSignInRequired}
          />
        )}
        {datasetsState.status === "loaded" && datasetsState.resource.datasets.length === 0 && (
          <div className="empty-state">
            <span className="empty-state-icon">
              <DatasetIcon size={22} />
            </span>
            <h2>No Datasets yet</h2>
            <p>Create a Dataset, then add the Test Cases your application should meet.</p>
          </div>
        )}
        {datasetsState.status === "loaded" && datasetsState.resource.datasets.length > 0 && (
          <DatasetTable datasets={datasetsState.resource.datasets} />
        )}
      </section>
    </div>
  );
}

function NewDatasetForm({ credentials }: { credentials: ApiCredentials }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    if (name.trim() === "") {
      setProblem("Give the Dataset a name.");
      return;
    }
    setIsCreating(true);
    setProblem(null);
    try {
      const dataset = await createDataset(credentials, { name: name.trim() });
      navigate(datasetPagePath(dataset.name));
    } catch (error) {
      setProblem((error as Error).message);
      setIsCreating(false);
    }
  };

  return (
    <section className="panel panel-form" aria-label="New Dataset">
      <form className="inline-form" onSubmit={submit} noValidate>
        <label htmlFor="new-dataset-name" className="visually-hidden">Dataset name</label>
        <input
          id="new-dataset-name"
          className="text-input"
          placeholder="Dataset name, such as support-bot"
          autoComplete="off"
          spellCheck={false}
          value={name}
          onChange={(changeEvent) => setName(changeEvent.target.value)}
        />
        <button type="submit" className="button button-primary" disabled={isCreating}>
          <PlusIcon size={14} />
          Create Dataset
        </button>
      </form>
      {problem !== null && (
        <p className="form-problem" role="alert">
          <AlertIcon size={14} />
          {problem}
        </p>
      )}
    </section>
  );
}

function DatasetTable({ datasets }: { datasets: Dataset[] }) {
  const nowUnixMilliseconds = useNow(15_000);
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Dataset</th>
            <th scope="col" className="column-numeric">Test Cases</th>
            <th scope="col" className="column-numeric">Updated</th>
          </tr>
        </thead>
        <tbody>
          {datasets.map((dataset) => (
            <tr key={dataset.name}>
              <td className="cell-breaks-anywhere">
                <Link to={datasetPagePath(dataset.name)}>{dataset.name}</Link>
              </td>
              <td className="column-numeric">{dataset.testCaseCount}</td>
              <td
                className="column-numeric text-muted"
                title={new Date(dataset.updatedAt).toLocaleString()}
              >
                {formatRelativeTime(Date.parse(dataset.updatedAt), nowUnixMilliseconds)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
