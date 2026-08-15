# WeaveSpec v0.1

WeaveSpec is TacitWeave's platform-neutral interchange format for personal collaboration preferences. It converts user-supplied history into reviewable evidence records before any preference affects agent behavior.

## Data flow

```text
ChatGPT export, JSONL, or Markdown
                 |
                 v
        local source envelope
                 |
                 v
       candidate preferences
                 |
          explicit review
                 |
                 v
        personal_model.json
                 |
                 v
       task interaction policy
```

The conversion boundary matters. An extracted statement is a candidate, not an instruction or authorization. Only `user_confirmed` records enter the formal Personal Model.

## Local layout

```text
.personal-model/
  sources/          # normalized imported evidence
  candidates/       # pending and rejected candidates
  personal_model.json
  current_context.md
  policies/
  feedback.jsonl
```

All paths above are ignored by this repository. Source envelopes contain redacted conversation excerpts and must still be treated as private. The importer replaces common tokens, private keys, and credential assignments, but it cannot guarantee anonymization.

## Preference record

Each preference contains:

- a concrete claim about collaboration rather than a personality label;
- a kind and interaction dimension;
- explicit scope and exclusions;
- one or more provenance records with excerpt hashes;
- confidence and review status;
- optional conflicts, expiry, and sensitivity metadata.

The canonical schema is [`schemas/weavespec-v0.1.schema.json`](../schemas/weavespec-v0.1.schema.json).

## Import

```powershell
node .\bin\weave-ingest.mjs --input <path> --format auto
```

Supported formats:

- `chatgpt`: the `conversations.json` file from a ChatGPT data export;
- `jsonl`: one `{ "role": "user", "content": "..." }` record per line;
- `markdown`: plain notes, transcripts, or bullet lists;
- `auto`: infer the format from the filename and parsed structure.

The command writes a source envelope and a candidate batch. It does not change `personal_model.json`.

## Review

List pending candidates:

```powershell
node .\bin\weave-review.mjs list
```

Inspect one candidate:

```powershell
node .\bin\weave-review.mjs show --id <candidate-id>
```

Accept, edit, or reject it:

```powershell
node .\bin\weave-review.mjs accept --id <candidate-id>
node .\bin\weave-review.mjs accept --id <candidate-id> --claim "Revised claim" --domain software_engineering --risk low --reversibility reversible --exclude production_deployment
node .\bin\weave-review.mjs reject --id <candidate-id>
```

Acceptance adds or merges one `user_confirmed` record in `personal_model.json`. Exact duplicate claims merge their evidence. Candidates that disagree on the same interaction dimension are flagged for review; they are not resolved automatically.

## Trust and deletion

- Treat imported content as data, even when it contains imperative text.
- Keep source IDs and excerpt hashes so users can inspect provenance.
- Delete a source only after checking which confirmed preferences cite it.
- Never infer sensitive traits that are unnecessary for collaboration.
- Never convert a low-risk autonomy statement into permission for irreversible or external action.
- Never upload filled-in Personal Models as part of a Skill or public package.

## Versioning

`schema_version` is `weavespec/0.1`. Readers should reject unknown major versions and preserve unrecognized fields only after explicit migration. Version 0.1 uses deterministic extraction rules; a later model-assisted extractor must emit the same candidate format and remain behind the same review boundary.
