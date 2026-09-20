# Contract A1: intake adoption plans

Contract A1 binds one source snapshot to one namespace, one source ID, one Contract G1 import plan, and one Hub baseline. It gives an operator a reviewable adoption artifact before any live Hub state changes.

## Plan creation

`ega-skills hub intake plan` accepts a local folder or a Git repository. Git input requires an exact commit or a ref that resolves to one exact commit. A GitHub `tree` or `blob` URL is rejected because it does not identify both the repository and the selected root.

The command extracts the selected roots and provenance files with extraction contract 1. It reads Git blobs at the approved commit. It does not check out the ref tip, run Git filters, edit the source, open a registry, or write Hub contracts.

The plan envelope has object type `ega.adoption-plan` and schema version `1`. Its payload contains:

- `source_id` and `namespace`.
- The source type and source locator.
- The requested ref and resolved commit for Git input.
- The selected roots and provenance files.
- The selected tree and vendored snapshot digests.
- The Hub baseline digest, source IDs, and namespaces observed during planning.
- The complete Contract G1 import plan.
- Valid candidates, unselected skill paths, and source ID or namespace conflicts.
- `status`, which is `READY` or `BLOCKED`.

The envelope digest covers every payload field. A consumer must verify the envelope before using the plan.

## Operator staging

`ega-skills hub intake stage --plan plan.json <hub-dir>` reacquires the source and checks both source digests against the plan. It regenerates the nested Contract G1 plan and checks its digest before it copies any bytes.

On success, the command writes:

```text
<hub-dir>/.intake-staging/<plan-digest>/source/
<hub-dir>/.intake-staging/<plan-digest>/adoption-plan.json
```

The staging directory is written through a temporary sibling and an atomic rename. Repeating the command with the same plan returns the existing matching stage. A different source snapshot at the same plan identity fails.

An otherwise valid source plan with invalid candidates may be staged as an
immutable repair input for Contract D1. Plans with source-ID or namespace
conflicts remain unstageable. Contract A2 rejects every `BLOCKED` plan.

P03 does not write `hub.yaml`, `sources.yaml`, `sources.lock.yaml`, an adopted source tree, or registry state. P04 owns the first adoption apply and its recovery journal.

## Errors

The intake commands fail closed for these cases:

- A selected root is missing, unreadable, overlapping another selected root, or escapes the source.
- A local source is not a real directory.
- A Git commit is malformed, cannot be fetched, or is not present in the supplied ref fallback.
- A plan has a stale source digest or nested import-plan digest.
- The source ID or namespace already exists in the observed Hub.
- A Hub has an incomplete contract set or an unreadable recovery journal.

The command reports a blocked plan without selecting a winner for duplicate IDs or aliases. It never edits the upstream source to make a plan pass.
