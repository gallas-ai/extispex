import { type FormEvent, type ReactNode, useCallback, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { ApiCredentials } from "../api/api-request.ts";
import { createTestCase, getTestCase, updateTestCase } from "../api/evaluation-api.ts";
import { Breadcrumbs } from "../prompts/prompt-parts.tsx";
import { useCanEditProject } from "../sign-in/access-context.ts";
import { AlertIcon, PlusIcon, TrashIcon } from "../ui/icons.tsx";
import { LoadError } from "../ui/load-error.tsx";
import { useApiResource } from "../ui/use-api-resource.ts";
import { datasetPagePath } from "./dataset-paths.ts";
import {
  checkDraft,
  createDraftFromTestCase,
  type EvaluatorDraft,
  NEW_REGEX_EVALUATOR_DRAFT,
  NEW_TELEMETRY_EVALUATOR_DRAFT,
  NEW_TEST_CASE_DRAFT,
  type RegexEvaluatorDraft,
  type TelemetryEvaluatorDraft,
  type TestCaseDraft,
} from "./test-case-draft.ts";

interface TestCaseEditorPageProps {
  credentials: ApiCredentials;
  onSignInRequired: () => void;
}

export function NewTestCasePage({ credentials }: TestCaseEditorPageProps) {
  const datasetName = useParams().datasetName as string;
  const navigate = useNavigate();
  return (
    <div className="page page-constrained">
      <EditorBreadcrumbs datasetName={datasetName} label="New Test Case" />
      <div className="page-header">
        <div className="page-heading">
          <h1>New Test Case</h1>
        </div>
      </div>
      <TestCaseForm
        initialDraft={NEW_TEST_CASE_DRAFT}
        isNameEditable
        canSave
        submitLabel="Create Test Case"
        cancelPath={datasetPagePath(datasetName)}
        onSubmit={async (draft, definition) => {
          await createTestCase(credentials, datasetName, {
            ...definition,
            name: draft.name.trim(),
          });
          navigate(datasetPagePath(datasetName));
        }}
      />
    </div>
  );
}

export function EditTestCasePage({ credentials, onSignInRequired }: TestCaseEditorPageProps) {
  const { datasetName, testCaseName } = useParams() as {
    datasetName: string;
    testCaseName: string;
  };
  const navigate = useNavigate();
  const canEdit = useCanEditProject();
  const loadTestCase = useCallback(
    () => getTestCase(credentials, datasetName, testCaseName),
    [credentials, datasetName, testCaseName],
  );
  const [testCaseState, reloadTestCase] = useApiResource(loadTestCase);

  return (
    <div className="page page-constrained">
      <EditorBreadcrumbs datasetName={datasetName} label={testCaseName} />
      <div className="page-header">
        <div className="page-heading">
          <h1 className="prompt-title">{testCaseName}</h1>
          <p className="page-subtitle">
            Changes apply to future Evaluation Runs. Runs that have started keep their copy.
          </p>
        </div>
      </div>
      {testCaseState.status === "loading" && (
        <section className="panel">
          <div className="panel-loading" aria-busy="true" />
        </section>
      )}
      {testCaseState.status === "failed" && (
        <section className="panel">
          <LoadError
            subject="The Test Case"
            message={testCaseState.message}
            isSignInRequired={testCaseState.isSignInRequired}
            onRetry={reloadTestCase}
            onSignInRequired={onSignInRequired}
          />
        </section>
      )}
      {testCaseState.status === "loaded" && (
        <TestCaseForm
          initialDraft={createDraftFromTestCase(testCaseState.resource)}
          isNameEditable={false}
          canSave={canEdit}
          submitLabel="Save Test Case"
          cancelPath={datasetPagePath(datasetName)}
          onSubmit={async (_draft, definition) => {
            await updateTestCase(credentials, datasetName, testCaseName, definition);
            navigate(datasetPagePath(datasetName));
          }}
        />
      )}
    </div>
  );
}

function EditorBreadcrumbs({ datasetName, label }: { datasetName: string; label: string }) {
  return (
    <Breadcrumbs
      items={[
        { label: "Datasets", path: "/datasets" },
        { label: datasetName, path: datasetPagePath(datasetName) },
        { label },
      ]}
    />
  );
}

interface TestCaseFormProps {
  initialDraft: TestCaseDraft;
  isNameEditable: boolean;
  canSave: boolean;
  submitLabel: string;
  cancelPath: string;
  onSubmit: (
    draft: TestCaseDraft,
    definition: Parameters<typeof updateTestCase>[3],
  ) => Promise<void>;
}

function TestCaseForm(
  { initialDraft, isNameEditable, canSave, submitLabel, cancelPath, onSubmit }: TestCaseFormProps,
) {
  const [draft, setDraft] = useState(initialDraft);
  const [problem, setProblem] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const updateDraft = (changes: Partial<TestCaseDraft>) => setDraft({ ...draft, ...changes });
  const updateEvaluator = (evaluatorIndex: number, replacement: EvaluatorDraft) =>
    updateDraft({
      evaluators: draft.evaluators.map((evaluator, index) =>
        index === evaluatorIndex ? replacement : evaluator
      ),
    });
  const addEvaluator = (newEvaluator: EvaluatorDraft) =>
    updateDraft({ evaluators: [...draft.evaluators, newEvaluator] });

  const submit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    if (isNameEditable && draft.name.trim() === "") {
      setProblem("Give the Test Case a name.");
      return;
    }
    const draftCheck = checkDraft(draft);
    if (!draftCheck.isValid) {
      setProblem(draftCheck.problem);
      return;
    }
    setProblem(null);
    setIsSaving(true);
    try {
      await onSubmit(draft, draftCheck.definition);
    } catch (error) {
      setProblem((error as Error).message);
      setIsSaving(false);
    }
  };

  return (
    <form className="editor-layout" onSubmit={submit} noValidate>
      <div className="editor-main">
        <div className="form-card">
          {isNameEditable && (
            <div className="form-field">
              <label className="field-label" htmlFor="test-case-name">Name</label>
              <input
                id="test-case-name"
                className="text-input"
                autoComplete="off"
                spellCheck={false}
                value={draft.name}
                onChange={(changeEvent) => updateDraft({ name: changeEvent.target.value })}
              />
            </div>
          )}
          <div className="form-field">
            <label className="field-label" htmlFor="test-case-input">Input</label>
            <textarea
              id="test-case-input"
              className="text-area text-input-mono"
              rows={5}
              spellCheck={false}
              value={draft.input}
              onChange={(changeEvent) => updateDraft({ input: changeEvent.target.value })}
            />
            <p className="field-hint">
              JSON or plain text. Your script receives it and calls the application.
            </p>
          </div>
          <div className="form-field">
            <label className="field-label" htmlFor="test-case-expected">Expected output</label>
            <textarea
              id="test-case-expected"
              className="text-area"
              rows={2}
              value={draft.expectedOutput}
              onChange={(changeEvent) => updateDraft({ expectedOutput: changeEvent.target.value })}
            />
            <p className="field-hint">Optional. Passed to your script as given.</p>
          </div>
        </div>
        <div className="form-card">
          <div className="form-card-header">
            <h2 className="section-title">Evaluators</h2>
            <div className="form-card-actions">
              <button
                type="button"
                className="button button-secondary button-small"
                onClick={() => addEvaluator(NEW_REGEX_EVALUATOR_DRAFT)}
              >
                <PlusIcon size={13} />
                Add Regex Evaluator
              </button>
              <button
                type="button"
                className="button button-secondary button-small"
                onClick={() => addEvaluator(NEW_TELEMETRY_EVALUATOR_DRAFT)}
              >
                <PlusIcon size={13} />
                Add Telemetry Evaluator
              </button>
            </div>
          </div>
          <ol className="evaluator-editor-list">
            {draft.evaluators.map((evaluator, evaluatorIndex) => (
              <EvaluatorFields
                key={evaluatorIndex}
                evaluator={evaluator}
                evaluatorNumber={evaluatorIndex + 1}
                canRemove={draft.evaluators.length > 1}
                onChange={(replacement) => updateEvaluator(evaluatorIndex, replacement)}
                onRemove={() =>
                  updateDraft({
                    evaluators: draft.evaluators.filter((_, index) => index !== evaluatorIndex),
                  })}
              />
            ))}
          </ol>
        </div>
      </div>
      <div className="editor-side">
        <div className="form-card">
          <div className="form-field">
            <label className="field-label" htmlFor="test-case-iterations">Iterations</label>
            <input
              id="test-case-iterations"
              className="text-input"
              inputMode="numeric"
              value={draft.iterations}
              onChange={(changeEvent) => updateDraft({ iterations: changeEvent.target.value })}
            />
          </div>
          <div className="form-field">
            <label className="field-label" htmlFor="test-case-threshold">
              Pass Threshold (%)
            </label>
            <input
              id="test-case-threshold"
              className="text-input"
              inputMode="decimal"
              value={draft.passThresholdPercent}
              onChange={(changeEvent) =>
                updateDraft({ passThresholdPercent: changeEvent.target.value })}
            />
            <p className="field-hint">The share of Iterations that must pass.</p>
          </div>
          {problem !== null && (
            <p className="form-problem" role="alert">
              <AlertIcon size={14} />
              {problem}
            </p>
          )}
          <div className="form-actions">
            <Link className="button button-secondary" to={cancelPath}>Cancel</Link>
            {canSave && (
              <button type="submit" className="button button-primary" disabled={isSaving}>
                {submitLabel}
              </button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}

interface EvaluatorFieldsProps {
  evaluator: EvaluatorDraft;
  evaluatorNumber: number;
  canRemove: boolean;
  onChange: (replacement: EvaluatorDraft) => void;
  onRemove: () => void;
}

function EvaluatorFields(
  { evaluator, evaluatorNumber, canRemove, onChange, onRemove }: EvaluatorFieldsProps,
) {
  const removeButton = (
    <button
      type="button"
      className="icon-button button-danger"
      aria-label={`Remove Evaluator ${evaluatorNumber}`}
      title="Remove Evaluator"
      disabled={!canRemove}
      onClick={onRemove}
    >
      <TrashIcon size={14} />
    </button>
  );
  return evaluator.type === "regex"
    ? (
      <RegexEvaluatorFields
        evaluator={evaluator}
        evaluatorNumber={evaluatorNumber}
        removeButton={removeButton}
        onChange={onChange}
      />
    )
    : (
      <TelemetryEvaluatorFields
        evaluator={evaluator}
        evaluatorNumber={evaluatorNumber}
        removeButton={removeButton}
        onChange={onChange}
      />
    );
}

function RegexEvaluatorFields(
  { evaluator, evaluatorNumber, removeButton, onChange }: {
    evaluator: RegexEvaluatorDraft;
    evaluatorNumber: number;
    removeButton: ReactNode;
    onChange: (replacement: RegexEvaluatorDraft) => void;
  },
) {
  const idPrefix = `evaluator-${evaluatorNumber}`;
  const update = (changes: Partial<RegexEvaluatorDraft>) => onChange({ ...evaluator, ...changes });
  return (
    <li className="evaluator-editor">
      <div className="form-field-row">
        <div className="form-field">
          <label className="field-label" htmlFor={`${idPrefix}-name`}>
            Evaluator {evaluatorNumber} name
          </label>
          <input
            id={`${idPrefix}-name`}
            className="text-input"
            autoComplete="off"
            value={evaluator.name}
            onChange={(changeEvent) => update({ name: changeEvent.target.value })}
          />
        </div>
        <div className="form-field">
          <label className="field-label" htmlFor={`${idPrefix}-flags`}>
            Evaluator {evaluatorNumber} flags
          </label>
          <input
            id={`${idPrefix}-flags`}
            className="text-input text-input-mono"
            autoComplete="off"
            spellCheck={false}
            placeholder="i, m, s, u"
            value={evaluator.flags}
            onChange={(changeEvent) => update({ flags: changeEvent.target.value })}
          />
        </div>
      </div>
      <div className="form-field">
        <label className="field-label" htmlFor={`${idPrefix}-pattern`}>
          Evaluator {evaluatorNumber} regular expression
        </label>
        <input
          id={`${idPrefix}-pattern`}
          className="text-input text-input-mono"
          autoComplete="off"
          spellCheck={false}
          value={evaluator.pattern}
          onChange={(changeEvent) => update({ pattern: changeEvent.target.value })}
        />
      </div>
      <div className="evaluator-editor-footer">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={!evaluator.expectMatch}
            onChange={(changeEvent) => update({ expectMatch: !changeEvent.target.checked })}
          />
          Pass when the Output does not match
        </label>
        {removeButton}
      </div>
    </li>
  );
}

function TelemetryEvaluatorFields(
  { evaluator, evaluatorNumber, removeButton, onChange }: {
    evaluator: TelemetryEvaluatorDraft;
    evaluatorNumber: number;
    removeButton: ReactNode;
    onChange: (replacement: TelemetryEvaluatorDraft) => void;
  },
) {
  const idPrefix = `evaluator-${evaluatorNumber}`;
  const update = (changes: Partial<TelemetryEvaluatorDraft>) =>
    onChange({ ...evaluator, ...changes });
  return (
    <li className="evaluator-editor">
      <div className="form-field-row">
        <div className="form-field">
          <label className="field-label" htmlFor={`${idPrefix}-name`}>
            Evaluator {evaluatorNumber} name
          </label>
          <input
            id={`${idPrefix}-name`}
            className="text-input"
            autoComplete="off"
            value={evaluator.name}
            onChange={(changeEvent) => update({ name: changeEvent.target.value })}
          />
        </div>
        <div className="form-field">
          <label className="field-label" htmlFor={`${idPrefix}-status`}>
            Evaluator {evaluatorNumber} span status
          </label>
          <select
            id={`${idPrefix}-status`}
            className="select-input"
            value={evaluator.status}
            onChange={(changeEvent) =>
              update({ status: changeEvent.target.value as TelemetryEvaluatorDraft["status"] })}
          >
            <option value="">Any</option>
            <option value="ok">OK</option>
            <option value="error">Error</option>
            <option value="unset">Unset</option>
          </select>
        </div>
      </div>
      <div className="form-field">
        <label className="field-label" htmlFor={`${idPrefix}-span-name`}>
          Evaluator {evaluatorNumber} span name
        </label>
        <input
          id={`${idPrefix}-span-name`}
          className="text-input text-input-mono"
          autoComplete="off"
          spellCheck={false}
          value={evaluator.spanName}
          onChange={(changeEvent) => update({ spanName: changeEvent.target.value })}
        />
      </div>
      <div className="form-field">
        <label className="field-label" htmlFor={`${idPrefix}-attributes`}>
          Evaluator {evaluatorNumber} attributes
        </label>
        <textarea
          id={`${idPrefix}-attributes`}
          className="text-area text-input-mono"
          rows={3}
          spellCheck={false}
          placeholder='{"gen_ai.tool.name": "lookup_refund"}'
          value={evaluator.attributes}
          onChange={(changeEvent) => update({ attributes: changeEvent.target.value })}
        />
        <p className="field-hint">
          Optional JSON. A span matches when it meets every condition given here.
        </p>
      </div>
      <div className="form-field-row">
        <div className="form-field">
          <label className="field-label" htmlFor={`${idPrefix}-minimum`}>
            Evaluator {evaluatorNumber} minimum count
          </label>
          <input
            id={`${idPrefix}-minimum`}
            className="text-input"
            inputMode="numeric"
            value={evaluator.minimumCount}
            onChange={(changeEvent) => update({ minimumCount: changeEvent.target.value })}
          />
        </div>
        <div className="form-field">
          <label className="field-label" htmlFor={`${idPrefix}-maximum`}>
            Evaluator {evaluatorNumber} maximum count
          </label>
          <input
            id={`${idPrefix}-maximum`}
            className="text-input"
            inputMode="numeric"
            placeholder="No limit"
            value={evaluator.maximumCount}
            onChange={(changeEvent) => update({ maximumCount: changeEvent.target.value })}
          />
        </div>
      </div>
      <div className="evaluator-editor-footer">
        <span className="status-text">How many spans must match. 0 and 0 forbid such a span.</span>
        {removeButton}
      </div>
    </li>
  );
}
