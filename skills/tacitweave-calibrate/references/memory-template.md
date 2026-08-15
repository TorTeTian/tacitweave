# Personal Model template

Use WeaveSpec for a portable Personal Model. Keep filled-in files outside the Skill package.

```json
{
  "schema_version": "weavespec/0.1",
  "subject": {
    "id": "local-user",
    "label": null
  },
  "updated_at": null,
  "preferences": [],
  "safety_invariants": [
    "Destructive, irreversible, financial, privacy-sensitive, publishing, production, and external communication actions require explicit confirmation.",
    "A general preference for autonomy never overrides a narrower risk boundary."
  ]
}
```

Each confirmed preference needs a concrete claim, kind, dimension, scope, exclusions, evidence provenance, confidence, sensitivity, and review timestamps. Use only records with `status: user_confirmed`.

Keep raw imports and unreviewed candidates outside the formal model:

```text
.personal-model/
  sources/
  candidates/
  personal_model.json
  current_context.md
```

Do not store passwords, API keys, authentication tokens, private keys, recovery codes, or raw confidential documents in the model. Separate stable preferences from temporary project context. Add an exclusion when a preference could become dangerous outside its original scope. Never copy a filled-in Personal Model into a public Skill package.
