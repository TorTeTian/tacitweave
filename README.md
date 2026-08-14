# TacitWeave

> Experimental software. TacitWeave is a test build for studying explicit interaction-policy calibration. It does not replace DSH sandboxing, approvals, or permission controls.

TacitWeave is a DeepSeek Harness bundle that turns stored user preferences into a policy for the current task. Before a tool changes files or external state, the agent can show its working assumptions and ask the user to confirm or correct them. DSH blocks configured side-effect tools until that calibration step is complete.

The project tests a narrow question: does an explicit, editable collaboration policy work better than asking a model to infer the user's preferred working style silently?

## What it does

- Reads `personal_model.json` and `current_context.md` from a project-local `.personal-model` directory.
- Compiles an `act`, `ask`, `propose`, or `explain_then_act` policy for each new task.
- Pauses for confirmation when the policy is uncertain or the task carries enough risk.
- Saves each policy under `.personal-model/policies/<session>/turn-<n>.json`.
- Appends user corrections to `.personal-model/feedback.jsonl` for later review.
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

For local development, clone the repository and install it from the checkout:

```powershell
git clone https://github.com/TorTeTian/tacitweave.git
cd tacitweave
dsh plugin --profile web add .
dsh --profile web --dump-config
dsh web
```

The repository is plain JavaScript and has no `prepare` build script. For repeatable tests, use a known commit instead of relying on a moving branch.

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

## Privacy model

Personal data is stored under:

```text
.personal-model/
  personal_model.json
  current_context.md
  policies/
  feedback.jsonl
```

This directory is ignored by Git and omitted from the npm package. The tracked files under `examples/memory/` contain placeholders only. TacitWeave does not include telemetry or its own network client.

Local storage does not mean the memory stays on the machine during a model run. TacitWeave inserts the loaded memory into the DSH model context. If DSH uses a remote model provider, that provider receives the inserted text. The `tacitweave_inspect` output may also become part of the chat transcript. Keep the memory files small, avoid secrets, and check the retention policy of the configured provider. Use a local model endpoint if the prompt itself must remain local.

Policy records and feedback can contain task details or user corrections. Treat the whole `.personal-model` directory as private data. TacitWeave never promotes a single correction directly into `personal_model.json`; corrections remain in the feedback log until a person reviews them.

## Export project context

```powershell
node .\bin\export-context.mjs --root . --output .\.personal-model\exports\current-context.md
```

The exporter skips Git data, dependency directories, virtual environments, `work`, common key files, and strings that resemble tokens. It also limits individual file size and total output size. This is a screening step, not a privacy guarantee. Read the exported Markdown before sending it to any model.

## Configuration

By default, the bundle reads `.personal-model` from the current working directory. Override the `tacitweave` row in the profile's `cordis.patch.yml` when the memory lives elsewhere.

The main settings are:

- `memoryDir`: directory containing the private memory files
- `calibrationMode`: `always`, `adaptive`, or `off`
- `maxMemoryChars`: maximum number of memory characters inserted into each model step
- `gatedTools`: tool names that require calibration before execution

## ChatGPT desktop support

Version 0.1 does not enforce the calibration gate in the ChatGPT desktop app. DSH exposes hooks for system prompts, user questions, and pre-execution tool policy; the ChatGPT desktop app does not expose an equivalent local plugin surface. You can provide the exported Markdown to ChatGPT manually, but this only transfers context. It cannot force the model to pause before acting.

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
- Personal-model files have no automatic conflict resolution or schema migration.
- The project has not completed a user study and makes no claim that it improves collaboration quality.
