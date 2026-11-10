import type { Target, TestCase } from "@extispex/contracts";
import { type FormEvent, useCallback, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { ApiCredentials } from "../api/api-request.ts";
import {
  createEvaluationRun,
  deleteDataset,
  deleteTestCase,
  getDataset,
  listTargets,
  listTestCases,
} from "../api/evaluation-api.ts";
import { Breadcrumbs } from "../prompts/prompt-parts.tsx";
import { useCanEditProject } from "../sign-in/access-context.ts";
import { AlertIcon, DatasetIcon, PlusIcon, RunIcon, TrashIcon } from "../ui/icons.tsx";
import { LoadError } from "../ui/load-error.tsx";
import { useApiResource } from "../ui/use-api-resource.ts";
import { newTestCasePath, testCaseEditorPath } from "./dataset-paths.ts";

interface DatasetPageProps {
  credentials: ApiCredentials;
  onSignInRequired: () => void;
}

export function DatasetPage({ credentials, onSignInRequired }: DatasetPageProps) {
  const canEdit = useCanEditProject();
  const navigate = useNavigate();
  const datasetName = useParams().datasetName as string;
  const [problem, setProblem] = useState<string | null>(null);
  const loadDataset = useCallback(async () => {
    const [dataset, { testCases }, { targets }] = await Promise.all([
      getDataset(credentials, datasetName),
      listTestCases(credentials, datasetName),
      listTargets(credentials),
    ]);
    return { dataset, testCases, targets };
  }, [credentials, datasetName]);
  const [datasetState, reloadDataset] = useApiResource(loadDataset);

  const removeDataset = async () => {
    setProblem(null);
    try {
      await deleteDataset(credentials, datasetName);
      navigate("/datasets");
    } catch (error) {
      setProblem((error as Error).message);
    }
  };

  const removeTestCase = async (testCaseName: string) => {
    setProblem(null);
    try {
      await deleteTestCase(credentials, datasetName, testCaseName);
      reloadDataset();
    } catch (error) {
      setProblem((error as Error).message);
    }
  };

  return (
    <div className="page page-constrained">
      <Breadcrumbs items={[{ label: "Datasets", path: "/datasets" }, { label: datasetName }]} />
      <div className="page-header">
        <div className="page-heading">
          <h1 className="prompt-title">{datasetName}</h1>
          <p className="page-subtitle">
            {datasetState.status === "loaded"
              ? `${datasetState.resource.testCases.length} ${
                datasetState.resource.testCases.length === 1 ? "Test Case" : "Test Cases"
              }`
              : " "}
          </p>
        </div>
        {canEdit && (
          <div className="page-actions">
            <button type="button" className="button button-secondary" onClick={removeDataset}>
              <TrashIcon size={14} />
              Delete Dataset
            </button>
            <Link className="button button-primary" to={newTestCasePath(datasetName)}>
              <PlusIcon size={14} />
              New Test Case
            </Link>
          </div>
        )}
      </div>
      {problem !== null && (
        <p className="form-problem" role="alert">
          <AlertIcon size={14} />
          {problem}
        </p>
      )}
      {canEdit && datasetState.status === "loaded" &&
        datasetState.resource.testCases.length > 0 && (
        <ServerRunForm
          credentials={credentials}
          datasetName={datasetName}
          targets={datasetState.resource.targets}
        />
      )}
      <section className="panel" aria-label="Test Case list">
        {datasetState.status === "loading" && <div className="panel-loading" aria-busy="true" />}
        {datasetState.status === "failed" && (
          <LoadError
            subject="The Dataset"
            message={datasetState.message}
            isSignInRequired={datasetState.isSignInRequired}
            onRetry={reloadDataset}
            onSignInRequired={onSignInRequired}
          />
        )}
        {datasetState.status === "loaded" && datasetState.resource.testCases.length === 0 && (
          <div className="empty-state">
            <span className="empty-state-icon">
              <DatasetIcon size={22} />
            </span>
            <h2>No Test Cases yet</h2>
            <p>
              A Test Case holds an input, or a Session's steps, and the Evaluators that judge the
              Output.
            </p>
          </div>
        )}
        {datasetState.status === "loaded" && datasetState.resource.testCases.length > 0 && (
          <TestCaseTable
            datasetName={datasetName}
            testCases={datasetState.resource.testCases}
            canEdit={canEdit}
            onDelete={removeTestCase}
          />
        )}
      </section>
    </div>
  );
}

/** Starts Server-Driven Execution: the worker calls the chosen Target for every Iteration. */
function ServerRunForm(
  { credentials, datasetName, targets }: {
    credentials: ApiCredentials;
    datasetName: string;
    targets: Target[];
  },
) {
  const navigate = useNavigate();
  const [targetName, setTargetName] = useState(targets[0]?.name ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const submit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    setProblem(null);
    setIsStarting(true);
    try {
      const work = await createEvaluationRun(credentials, {
        datasetName,
        executionMode: "server",
        targetName,
      });
      navigate(`/evaluation-runs/${encodeURIComponent(work.runId)}`);
    } catch (error) {
      setProblem((error as Error).message);
      setIsStarting(false);
    }
  };

  return (
    <section className="panel panel-form" aria-label="Run against a Target">
      {targets.length === 0
        ? (
          <p className="status-text">
            To run this Dataset from here,{" "}
            <Link to="/targets">create a Target</Link>. A script can run it with Client-Driven
            Execution instead.
          </p>
        )
        : (
          <form className="inline-form" onSubmit={submit}>
            <label htmlFor="run-target" className="visually-hidden">Target</label>
            <select
              id="run-target"
              className="select-input"
              value={targetName}
              onChange={(changeEvent) => setTargetName(changeEvent.target.value)}
            >
              {targets.map((target) => (
                <option key={target.name} value={target.name}>{target.name}</option>
              ))}
            </select>
            <button type="submit" className="button button-primary" disabled={isStarting}>
              <RunIcon size={14} />
              Run against Target
            </button>
          </form>
        )}
      {problem !== null && (
        <p className="form-problem" role="alert">
          <AlertIcon size={14} />
          {problem}
        </p>
      )}
    </section>
  );
}

function TestCaseTable(
  { datasetName, testCases, canEdit, onDelete }: {
    datasetName: string;
    testCases: TestCase[];
    canEdit: boolean;
    onDelete: (testCaseName: string) => void;
  },
) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Test Case</th>
            <th scope="col">Scope</th>
            <th scope="col" className="column-numeric">Evaluators</th>
            <th scope="col" className="column-numeric">Iterations</th>
            <th scope="col" className="column-numeric">Pass Threshold</th>
            {canEdit && <th scope="col" className="column-actions" aria-label="Actions" />}
          </tr>
        </thead>
        <tbody>
          {testCases.map((testCase) => (
            <tr key={testCase.name}>
              <td className="cell-breaks-anywhere">
                <Link to={testCaseEditorPath(datasetName, testCase.name)}>{testCase.name}</Link>
              </td>
              <td className="text-muted">
                {testCase.scope === "session"
                  ? `Session, ${testCase.steps?.length ?? 0} steps`
                  : "Trace"}
              </td>
              <td className="column-numeric">{testCase.evaluators.length}</td>
              <td className="column-numeric">{testCase.iterations}</td>
              <td className="column-numeric">{Math.round(testCase.passThreshold * 100)}%</td>
              {canEdit && (
                <td className="column-actions">
                  <button
                    type="button"
                    className="icon-button button-danger"
                    aria-label={`Delete Test Case ${testCase.name}`}
                    title="Delete Test Case"
                    onClick={() => onDelete(testCase.name)}
                  >
                    <TrashIcon size={14} />
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
