# Memory effectiveness evaluation

`pnpm run eval:memory` runs a live-model, controlled workflow test against the running ModelHarbor
service. It is not an official benchmark, and fixture contacts/projects are fictional. No real mail
is sent and no calendar event is created. Private account checks are separate from this experiment.

## Protocol fixed before execution

- Four tasks: supplier email draft, meeting entry preparation, staging deployment handoff, follow-up checklist.
- Each case first stores its facts through a real Chat request into an isolated Plasmod user workspace.
- Probes send only the task, **not** the earlier messages, seed facts or expected answer.
- Each task runs twice with recall off and twice with cross-session same-user recall on. Order is
  off/on then on/off; `memory_write: false` prevents test answers contaminating later probes.
- Exact case-insensitive required-fact checks score complete task satisfaction. They do not score
  prose quality or infer semantic equivalence, and can undercount correct paraphrases.
- Separate other-user and new-session-only probes test isolation and the existing session scope.
- No retry selection, best-of answers, or prompt tuning after seeing scores.

All prompts, required facts, seed responses, complete answer/recall traces, model/runtime metadata,
latency and outcomes are saved under ignored `runtime/evals/<run-id>/`. Incomplete runs have no final
summary; inspect `failure.txt`. Keep private real-account traces out of Git and upstream reports.

## Interpreting results

Recall hits alone are not proof of improvement. Compare complete-task scores, inspect exactly what
was retrieved and whether the answer used it, and inspect the negative controls. Report every task,
including failures. This small controlled sample supports only a narrow result, not a general
claim about autonomous-agent quality, long-term memory, or production isolation.

The initial run found that pinned Plasmod semantic retrieval could return a workspace-visible
Memory from session A when querying session B. ModelHarbor now validates returned canonical
tenant/workspace/agent/session metadata before prompt assembly and returns only scope-validated
evidence. An unknown identity is excluded. This may reduce recall when the upstream omits identity
metadata; inspect `scope_filtered_count` instead of treating an empty result as a model failure.
This is post-retrieval filtering, so a future upstream fix should apply selectors before top-K.

The Bench's recall-off toggle does **not** remove the visible conversation history from its prompt.
Use the evaluation script (fresh requests) for causal on/off comparisons. Session recall is the
compatible default; `memory_mode: user` explicitly searches earlier sessions in the same tenant/user
workspace. Actual authentication of that user must be supplied by a future gateway.
