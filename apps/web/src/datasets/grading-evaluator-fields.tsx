import type { LlmProvider, PromptSummary } from "@extispex/contracts";
import type { ReactNode } from "react";
import { PlusIcon, TrashIcon } from "../ui/icons.tsx";
import type { GradingEvaluatorDraft, JudgmentQuestionType } from "./test-case-draft.ts";

/** What a Grading Evaluator can choose from. */
export interface GradingOptions {
  providers: LlmProvider[];
  prompts: PromptSummary[];
}

const QUESTION_TYPE_LABELS: Record<JudgmentQuestionType, string> = {
  noul: "Yes or no",
  score: "Score on levels",
  choice: "Choice",
};

/** A Grading Evaluator: a Prompt Version for a Text Generation provider, a question for Jev. */
export function GradingEvaluatorFields(
  { evaluator, options, evaluatorNumber, removeButton, onChange }: {
    evaluator: GradingEvaluatorDraft;
    options: GradingOptions;
    evaluatorNumber: number;
    removeButton: ReactNode;
    onChange: (replacement: GradingEvaluatorDraft) => void;
  },
) {
  const idPrefix = `evaluator-${evaluatorNumber}`;
  const label = (text: string) => `Evaluator ${evaluatorNumber} ${text}`;
  const update = (changes: Partial<GradingEvaluatorDraft>) =>
    onChange({ ...evaluator, ...changes });
  const selectedPrompt = options.prompts.find((prompt) => prompt.name === evaluator.promptName);
  // A stored choice stays selectable even before the lists arrive, or after it was deleted.
  const providerNames = [
    ...new Set([
      ...options.providers.map((provider) => provider.name),
      ...(evaluator.providerName === "" ? [] : [evaluator.providerName]),
    ]),
  ];
  const promptNames = [
    ...new Set([
      ...options.prompts.map((prompt) => prompt.name),
      ...(evaluator.promptName === "" ? [] : [evaluator.promptName]),
    ]),
  ];
  const latestVersion = selectedPrompt?.latestVersionNumber ?? Number(evaluator.promptVersion);

  const chooseProvider = (providerName: string) => {
    const provider = options.providers.find((option) => option.name === providerName);
    update({
      providerName,
      ...(provider === undefined
        ? {}
        : { mode: provider.capabilities.includes("judgment") ? "question" : "prompt" }),
    });
  };

  return (
    <li className="evaluator-editor">
      <div className="form-field-row">
        <div className="form-field">
          <label className="field-label" htmlFor={`${idPrefix}-name`}>{label("name")}</label>
          <input
            id={`${idPrefix}-name`}
            className="text-input"
            autoComplete="off"
            value={evaluator.name}
            onChange={(changeEvent) => update({ name: changeEvent.target.value })}
          />
        </div>
        <div className="form-field">
          <label className="field-label" htmlFor={`${idPrefix}-provider`}>
            {label("LLM provider")}
          </label>
          <select
            id={`${idPrefix}-provider`}
            className="select-input"
            value={evaluator.providerName}
            onChange={(changeEvent) => chooseProvider(changeEvent.target.value)}
          >
            <option value="">Choose a provider</option>
            {providerNames.map((providerName) => (
              <option key={providerName} value={providerName}>{providerName}</option>
            ))}
          </select>
        </div>
      </div>
      {evaluator.mode === "prompt"
        ? (
          <div className="form-field-row">
            <div className="form-field">
              <label className="field-label" htmlFor={`${idPrefix}-prompt`}>
                {label("prompt")}
              </label>
              <select
                id={`${idPrefix}-prompt`}
                className="select-input"
                value={evaluator.promptName}
                onChange={(changeEvent) => {
                  const prompt = options.prompts.find((option) =>
                    option.name === changeEvent.target.value
                  );
                  update({
                    promptName: changeEvent.target.value,
                    promptVersion: prompt === undefined ? "" : String(prompt.latestVersionNumber),
                  });
                }}
              >
                <option value="">Choose a prompt</option>
                {promptNames.map((promptName) => (
                  <option key={promptName} value={promptName}>{promptName}</option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label className="field-label" htmlFor={`${idPrefix}-prompt-version`}>
                {label("Prompt Version")}
              </label>
              <select
                id={`${idPrefix}-prompt-version`}
                className="select-input"
                value={evaluator.promptVersion}
                onChange={(changeEvent) => update({ promptVersion: changeEvent.target.value })}
              >
                {evaluator.promptVersion === "" && <option value="">Choose a version</option>}
                {Array.from(
                  { length: Number.isFinite(latestVersion) ? latestVersion : 0 },
                  (_, index) => {
                    const versionNumber = latestVersion - index;
                    return (
                      <option key={versionNumber} value={String(versionNumber)}>
                        Version {versionNumber}
                      </option>
                    );
                  },
                )}
              </select>
            </div>
          </div>
        )
        : (
          <JudgmentQuestionFields
            evaluator={evaluator}
            idPrefix={idPrefix}
            label={label}
            update={update}
          />
        )}
      <p className="field-hint">
        {evaluator.mode === "prompt"
          ? "The prompt may use {{transcript}}, {{input}}, {{output}}, {{expectedOutput}}, " +
            "{{testCaseName}} and, with spans, {{spans}}. The LLM answers with a verdict, a score " +
            "and an explanation."
          : "Jev reads the Transcript and the expected output and answers with probabilities; the " +
            "rule below turns them into pass or fail."}
      </p>
      <div className="evaluator-editor-footer">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={evaluator.includeSpans}
            onChange={(changeEvent) => update({ includeSpans: changeEvent.target.checked })}
          />
          Include the spans of the traces
        </label>
        {removeButton}
      </div>
    </li>
  );
}

function JudgmentQuestionFields(
  { evaluator, idPrefix, label, update }: {
    evaluator: GradingEvaluatorDraft;
    idPrefix: string;
    label: (text: string) => string;
    update: (changes: Partial<GradingEvaluatorDraft>) => void;
  },
) {
  return (
    <>
      <div className="form-field-row">
        <div className="form-field">
          <label className="field-label" htmlFor={`${idPrefix}-question-type`}>
            {label("question type")}
          </label>
          <select
            id={`${idPrefix}-question-type`}
            className="select-input"
            value={evaluator.questionType}
            onChange={(changeEvent) =>
              update({ questionType: changeEvent.target.value as JudgmentQuestionType })}
          >
            {(Object.keys(QUESTION_TYPE_LABELS) as JudgmentQuestionType[]).map((questionType) => (
              <option key={questionType} value={questionType}>
                {QUESTION_TYPE_LABELS[questionType]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="form-field">
        <label className="field-label" htmlFor={`${idPrefix}-instructions`}>
          {label("question")}
        </label>
        <textarea
          id={`${idPrefix}-instructions`}
          className="text-area"
          rows={2}
          placeholder="Does the application tell the customer how long refunds are possible?"
          value={evaluator.instructions}
          onChange={(changeEvent) => update({ instructions: changeEvent.target.value })}
        />
      </div>
      {evaluator.questionType === "noul" && (
        <>
          <div className="form-field-row">
            <div className="form-field">
              <label className="field-label" htmlFor={`${idPrefix}-yes`}>
                {label("what yes means")}
              </label>
              <input
                id={`${idPrefix}-yes`}
                className="text-input"
                placeholder="Optional"
                value={evaluator.yesCriterion}
                onChange={(changeEvent) => update({ yesCriterion: changeEvent.target.value })}
              />
            </div>
            <div className="form-field">
              <label className="field-label" htmlFor={`${idPrefix}-no`}>
                {label("what no means")}
              </label>
              <input
                id={`${idPrefix}-no`}
                className="text-input"
                placeholder="Optional"
                value={evaluator.noCriterion}
                onChange={(changeEvent) => update({ noCriterion: changeEvent.target.value })}
              />
            </div>
          </div>
          <div className="form-field">
            <label className="field-label" htmlFor={`${idPrefix}-pass-probability`}>
              {label("least probability of yes")}
            </label>
            <input
              id={`${idPrefix}-pass-probability`}
              className="text-input"
              inputMode="decimal"
              value={evaluator.passProbability}
              onChange={(changeEvent) => update({ passProbability: changeEvent.target.value })}
            />
          </div>
        </>
      )}
      {evaluator.questionType === "score" && (
        <>
          <ListEditor
            idPrefix={`${idPrefix}-level`}
            itemLabel={(index) => label(`level ${index}`)}
            items={evaluator.levels}
            maximumCount={10}
            addLabel="Add level"
            onChange={(levels) => update({ levels })}
          />
          <div className="form-field">
            <label className="field-label" htmlFor={`${idPrefix}-pass-score`}>
              {label("least passing level")}
            </label>
            <input
              id={`${idPrefix}-pass-score`}
              className="text-input"
              inputMode="decimal"
              value={evaluator.passScore}
              onChange={(changeEvent) => update({ passScore: changeEvent.target.value })}
            />
            <p className="field-hint">
              Levels count from 0, lowest first; Jev's expected level must reach this.
            </p>
          </div>
        </>
      )}
      {evaluator.questionType === "choice" && (
        <div className="form-field">
          <span className="field-label">{label("choices")}</span>
          <ol className="judgment-criteria-list">
            {evaluator.choices.map((choice, choiceIndex) => {
              const replaceChoice = (changes: Partial<typeof choice>) =>
                update({
                  choices: evaluator.choices.map((existing, index) =>
                    index === choiceIndex ? { ...existing, ...changes } : existing
                  ),
                });
              return (
                <li key={choiceIndex} className="judgment-criterion">
                  <input
                    className="text-input text-input-mono"
                    aria-label={label(`choice ${choiceIndex + 1} name`)}
                    placeholder="polite"
                    value={choice.name}
                    onChange={(changeEvent) => replaceChoice({ name: changeEvent.target.value })}
                  />
                  <input
                    className="text-input"
                    aria-label={label(`choice ${choiceIndex + 1} description`)}
                    placeholder="When it applies"
                    value={choice.description}
                    onChange={(changeEvent) =>
                      replaceChoice({ description: changeEvent.target.value })}
                  />
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={choice.passes}
                      onChange={(changeEvent) =>
                        replaceChoice({ passes: changeEvent.target.checked })}
                    />
                    Passes
                  </label>
                  <button
                    type="button"
                    className="icon-button button-danger"
                    aria-label={label(`remove choice ${choiceIndex + 1}`)}
                    disabled={evaluator.choices.length <= 2}
                    onClick={() =>
                      update({
                        choices: evaluator.choices.filter((_, index) => index !== choiceIndex),
                      })}
                  >
                    <TrashIcon size={14} />
                  </button>
                </li>
              );
            })}
          </ol>
          <div>
            <button
              type="button"
              className="button button-secondary button-small"
              onClick={() =>
                update({
                  choices: [...evaluator.choices, { name: "", description: "", passes: false }],
                })}
            >
              <PlusIcon size={13} />
              Add choice
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function ListEditor(
  { idPrefix, itemLabel, items, maximumCount, addLabel, onChange }: {
    idPrefix: string;
    itemLabel: (index: number) => string;
    items: string[];
    maximumCount: number;
    addLabel: string;
    onChange: (items: string[]) => void;
  },
) {
  return (
    <div className="form-field">
      <ol className="judgment-criteria-list">
        {items.map((item, itemIndex) => (
          <li key={itemIndex} className="judgment-criterion">
            <label className="field-label" htmlFor={`${idPrefix}-${itemIndex}`}>
              {itemLabel(itemIndex)}
            </label>
            <input
              id={`${idPrefix}-${itemIndex}`}
              className="text-input"
              value={item}
              onChange={(changeEvent) =>
                onChange(
                  items.map((existing, index) =>
                    index === itemIndex ? changeEvent.target.value : existing
                  ),
                )}
            />
            <button
              type="button"
              className="icon-button button-danger"
              aria-label={`Remove ${itemLabel(itemIndex)}`}
              disabled={items.length <= 2}
              onClick={() => onChange(items.filter((_, index) => index !== itemIndex))}
            >
              <TrashIcon size={14} />
            </button>
          </li>
        ))}
      </ol>
      <div>
        <button
          type="button"
          className="button button-secondary button-small"
          disabled={items.length >= maximumCount}
          onClick={() => onChange([...items, ""])}
        >
          <PlusIcon size={13} />
          {addLabel}
        </button>
      </div>
    </div>
  );
}
