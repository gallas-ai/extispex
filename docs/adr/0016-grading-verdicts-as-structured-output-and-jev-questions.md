---
status: accepted
---

# Grading verdicts are structured output, and Jev gets typed questions of its own

A Grading Evaluator asks an LLM whether an Iteration passed. Free text would have to be parsed for a
verdict, and a parse that guesses wrong turns into a false pass or fail. So the verdict has a fixed
shape, and a provider that cannot follow a prompt gets a question in its own form.

**Text Generation providers** (OpenAI-compatible, Anthropic) receive the Evaluator's Prompt Version
and must answer with exactly this JSON, which matches the Evaluator result's pass or fail and
optional score:

```json
{ "passed": true, "score": 0.9, "explanation": "The bot states the 30-day refund period." }
```

The platform adds one instruction to the prompt's system message and asks the provider to enforce
the schema: OpenAI's `response_format` with a strict `json_schema`, Anthropic's
`output_config.format`. The answer is validated again on receipt. An answer that is not this object,
a refusal, or an answer cut off at the token limit is the Evaluator's Error, which retries the
attempt, never a failure: it says nothing about the application.

**TypeSafe Jev** (a Judgment provider) takes a state and typed questions, not a prompt, and answers
with probabilities. Its Grading Evaluator therefore names a `question` instead of a `prompt`. The
platform sends the Transcript as the state, and the Evaluator's own pass rule turns the answer into
pass or fail:

| Question | Jev answers                           | Passes when                                | Score                                  |
| -------- | ------------------------------------- | ------------------------------------------ | -------------------------------------- |
| `noul`   | the probability of yes                | it reaches `passProbability` (default 0.5) | the probability                        |
| `score`  | the expected level of ordered levels  | it reaches `passScore`                     | the expected level over the top level  |
| `choice` | one of named options with probability | the option is one of `passingChoices`      | the probability of the passing options |

```json
{
  "type": "grading",
  "name": "states-refund-period",
  "providerName": "jev",
  "question": {
    "type": "noul",
    "instructions": "Does the bot tell the customer how many days they have for a refund?",
    "passProbability": 0.7
  }
}
```

The state is `{ testCase, expectedOutput, transcript: [{ step, input, output }], spans }`, with
`expectedOutput` only when the Test Case has one and `spans` only with `includeSpans`. Jev's Box
questions locate things in images and have no use for a Transcript, so they are not offered.

## Considered Options

- **A JSON verdict enforced by the provider (chosen):** one shape for every Text Generation
  provider, which the result already stores, and invalid answers are detected instead of guessed.
- **A verdict word such as PASS or FAIL in free text:** works with any model, but a model that
  explains itself ("this would not PASS because…") is misread, and there is no score.
- **Tool use with a forced tool for the verdict:** the older way to get JSON from Anthropic, but
  current Claude models refuse a forced `tool_choice`, and structured output does the same job.
- **Making Jev follow prompts through a wrapper:** TypeSafe offers an adapter that answers chat
  prompts, but it hides the probabilities that make Jev useful as a judge and adds a translation
  layer that the platform cannot check.

## Consequences

- A local model behind an OpenAI-compatible server must support `response_format` with a JSON
  Schema, as vLLM and Ollama do; the verdict is also accepted inside a Markdown code block.
- `passed` and `score` are separate, so a provider can pass an Output with a low score. The verdict
  comes from `passed` only.
- Jev's thresholds are set per Evaluator, because its probabilities are calibrated but the right bar
  depends on the risk of the check. Jev's aliases move to new releases; a Test Case that needs fixed
  thresholds names a version such as `jev-1.14.0` as the provider's default model.
- A new question type or a new kind of provider adds a branch here without touching stored Test
  Cases, because both shapes are optional fields of the same Evaluator.
