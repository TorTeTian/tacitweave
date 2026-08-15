# TacitWeave

> Experimental software. TacitWeave is a test build for studying explicit interaction-policy calibration. It does not replace DSH sandboxing, approvals, or permission controls.

TacitWeave is a DeepSeek Harness bundle that turns stored user preferences into a policy for the current task. Before a tool changes files or external state, the agent can show its working assumptions and ask the user to confirm or correct them. DSH blocks configured side-effect tools until that calibration step is complete.

The project tests a narrow question: does an explicit, editable collaboration policy work better than asking a model to infer the user's preferred working style silently?

## What it does

- Reads `personal_model.json` and `current_context.md` from a project-local `.personal-model` directory.
- Converts ChatGPT exports, Markdown notes, and JSONL histories into reviewable WeaveSpec candidates.
- Turns direct calibration corrections into tentative, project-scoped candidates immediately.
- Promotes only explicitly reviewed candidates into durable memory without widening their declared scope.
- Compiles an `act`, `ask`, `propose`, or `explain_then_act` policy for each new task.
- Pauses for confirmation when the policy is uncertain or the task carries enough risk.
- Saves each policy under `.personal-model/policies/<session>/turn-<n>.json`.
- Appends user corrections to `.personal-model/feedback.jsonl` and a prioritized local review queue.
- Blocks configured file, shell, terminal, delegation, scheduling, and plugin tools until calibration succeeds.
- Exports a size-limited project context file with basic secret filtering.

## Compatibility

This test build targets:

- DeepSeek Harness Developer Preview `0.1.0-rc.6`
- Node.js 22.19 or newer
- Windows as the primary test environment

DSH is still a developer preview, so later releases may require adapter changes. TacitWeave keeps its storage and policy code separate from the DSH integration for that reason.

## Install

Install and start DeepSeek Harness first:

```powershell
npx @deepseek-ai/dsh web
```

Install TacitWeave from GitHub:

```powershell
dsh plugin --profile web add github:TorTeTian/tacitweave
```

To test an unmerged branch, include the branch name explicitly:

```powershell
dsh plugin --profile web add "github:TorTeTian/tacitweave#agent/fix-ingest-and-memory-path"
```

After installation, `C:\Users\<you>\.dsh\profiles\web\package.json` should contain a GitHub dependency, not a `link:` entry. A `link:` entry points DSH at a local checkout and can make Node resolve runtime dependencies from the wrong directory. Remove that installation and add the quoted GitHub spec again; do not substitute a downloaded folder or tarball when testing GitHub installation.

For local development, clone the repository and install it from the checkout:

```powershell
git clone https://github.com/TorTeTian/tacitweave.git
cd tacitweave
dsh plugin --profile web add .
dsh --profile web --dump-config
dsh web
```

The repository is plain JavaScript and has no `prepare` build script. For repeatable tests, use a known commit instead of relying on a moving branch.

If startup reports `ERR_MODULE_NOT_FOUND` for `@deepseek-ai/schemastery` or `@deepseek-ai/dsh-tools`, first inspect the profile package file:

```powershell
Select-String -Path "$env:USERPROFILE\.dsh\profiles\web\package.json" -Pattern 'dsh-tacitweave'
```

If the result begins with `link:`, reinstall it with the GitHub command above. TacitWeave declares both directly imported runtime packages as regular dependencies so a genuine GitHub installation installs them alongside the bundle.

## Create a local memory directory

The repository contains placeholder examples, not personal data. Copy them into the ignored local directory before editing them:

```powershell
New-Item -ItemType Directory -Force .personal-model
Copy-Item examples\memory\personal_model.example.json .personal-model\personal_model.json
Copy-Item examples\memory\current_context.example.md .personal-model\current_context.md
```

Start DSH from the project directory. A useful first prompt is:

> Call `tacitweave_inspect` and show which memory files and preferences are currently loaded.

Then give the agent a task that would modify a file. The agent should call `tacitweave_calibrate` first. The calibration dialog shows the task summary, proposed working mode, assumptions, actions the agent may take on its own, decisions reserved for the user, risk level, and confidence.

If the agent skips calibration and calls a protected tool, DSH denies the tool call and asks it to calibrate first.

## Import long-term memory

[WeaveSpec v0.2](docs/WEAVESPEC.md) defines a platform-neutral Personal Model with separate decision boundaries and preferences, evidence-derived confidence, scope, exclusions, activation tiers, review status, revocation, and provenance. The deterministic importer looks only for explicit preference language in user-authored messages. It does not ask a model for a personality summary.

Recognized ChatGPT/Codex reference envelopes containing `conversationId` and `priorConversation` are structurally expanded before preference extraction. Assistant text inside embedded history remains non-evidence, and raw outer JSON is never emitted as a candidate claim.

Import a ChatGPT `conversations.json`, Markdown file, or JSONL transcript:

```powershell
node .\bin\weave-ingest.mjs --input <path> --format auto
```

This creates a local source envelope and candidate batch without changing the formal Personal Model. Review candidates one at a time:

```powershell
node .\bin\weave-review.mjs list
node .\bin\weave-review.mjs digest --limit 2
node .\bin\weave-review.mjs show --id <candidate-id>
node .\bin\weave-review.mjs accept --id <candidate-id>
node .\bin\weave-review.mjs reject --id <candidate-id>
node .\bin\weave-review.mjs defer --id <candidate-id> --days 7
```

Use acceptance options to narrow an extracted claim before promotion:

```powershell
node .\bin\weave-review.mjs accept --id <candidate-id> --domain software_engineering --risk low --reversibility reversible --exclude production_changes
```

Legacy TacitWeave models remain readable. Convert the local file explicitly with:

```powershell
node .\bin\weave-review.mjs migrate
node .\bin\weave-review.mjs validate
```

Inspect or undo durable memory without erasing its audit trail:

```powershell
node .\bin\weave-review.mjs provenance --id <memory-id>
node .\bin\weave-review.mjs revoke --id <memory-id> --reason "outdated"
node .\bin\weave-review.mjs restore --id <memory-id>
node .\bin\weave-review.mjs source-impact --source <source-id>
```

Source deletion is deliberately two-step. Inspect impact first, then use `delete-source --source <source-id> --revoke-dependent true`. Confirmed records citing that source are revoked before the exact local source file is removed.

## Privacy model

Personal data is stored under:

```text
.personal-model/
  sources/
  candidates/
  personal_model.json
  current_context.md
  policies/
  feedback.jsonl
```

This directory is ignored by Git and omitted from the npm package. The tracked files under `examples/memory/` contain placeholders only. TacitWeave does not include telemetry or its own network client.

Local storage does not mean the memory stays on the machine during a model run. TacitWeave inserts the loaded memory into the DSH model context. If DSH uses a remote model provider, that provider receives the inserted text. The `tacitweave_inspect` output may also become part of the chat transcript. Keep the memory files small, avoid secrets, and check the retention policy of the configured provider. Use a local model endpoint if the prompt itself must remain local.

Source envelopes, candidates, policy records, and feedback can contain user text or task details. Treat the whole `.personal-model` directory as private data. Importing history never changes `personal_model.json`; only explicit review promotes a candidate. A direct calibration correction is usable immediately only as a tentative signal in the same project and for low-risk interpretation. It cannot authorize consequential action, and review does not widen its project scope unless the user explicitly edits that scope.

## Export project context

```powershell
node .\bin\export-context.mjs --root . --output .\.personal-model\exports\current-context.md
```

The exporter skips the complete `.personal-model` directory, Git data, dependency directories, virtual environments, `work`, common key files, and strings that resemble tokens. It omits the absolute project path and limits individual file size and total output size. This is a screening step, not a privacy guarantee. Read the exported Markdown before sending it to any model.

## Configuration

By default, the bundle reads `.personal-model` from the current working directory. Override the `tacitweave` row in the profile's `cordis.patch.yml` when the memory lives elsewhere.

Because a relative directory depends on where DSH or the CLI was started, use one absolute location for real testing. Either configure `memoryDir` with an absolute path or set `TACITWEAVE_MEMORY_DIR` before starting DSH and running CLI commands:

```powershell
$env:TACITWEAVE_MEMORY_DIR = 'D:\TacitWeave\.personal-model'
node .\bin\weave-review.mjs where
node .\bin\weave-ingest.mjs --input <path> --format auto
dsh web
```

`weave-ingest` prints the resolved memory directory and warns when a relative path was used. `tacitweave_inspect` reports the configured value, startup working directory, resolved path, and the same warning. This makes CLI/plugin divergence visible before review.

The main settings are:

- `memoryDir`: directory containing the private memory files
- `projectId`: stable identifier used to isolate tentative project memory
- `calibrationMode`: `always`, `adaptive`, or `off`
- `memoryReviewMode`: `selective` or `off`
- `language`: `auto` (follow the latest user message), `zh-CN`, or `en`
- `maxMemoryChars`: maximum number of memory characters inserted into each model step
- `gatedTools`: tool names that require calibration before execution

## ChatGPT desktop support

Version 0.2 does not enforce the calibration gate in the ChatGPT desktop app. DSH exposes hooks for system prompts, user questions, and pre-execution tool policy; the ChatGPT desktop app does not expose an equivalent local plugin surface. You can provide the exported Markdown to ChatGPT manually, but this only transfers context. It cannot force the model to pause before acting.

For ChatGPT Work, the repository includes the portable [`tacitweave-calibrate` Skill](skills/tacitweave-calibrate/SKILL.md). It compiles the same task-specific policy, pauses when a boundary needs confirmation, and keeps current corrections separate from long-term memory. The Skill guides model behavior; it cannot intercept Work tools or replace ChatGPT's own permission controls. Keep filled-in Personal Model files outside the Skill package and attach them only when a conversation needs them.

## Evaluation material

- [Scenario-writing specification](docs/SCENARIO_SPEC.md)
- [Scenario JSON Schema](scenarios/scenario.schema.json)
- [Twenty transfer scenarios](scenarios/transfer-scenarios.json)

## Verify the checkout

```powershell
npm run check
npm test
npm run pack:dry
```

## Known limits

- The agent must call the calibration tool. The DSH policy gate blocks configured side-effect tools, but it cannot prevent overconfident advice in plain text.
- The model assigns risk levels; this version has no independent risk classifier.
- The deterministic importer favors precision over recall and will miss preferences that are only implied.
- Conflicting preferences are flagged for review and never resolved automatically.
- The project has not completed a user study and makes no claim that it improves collaboration quality.
