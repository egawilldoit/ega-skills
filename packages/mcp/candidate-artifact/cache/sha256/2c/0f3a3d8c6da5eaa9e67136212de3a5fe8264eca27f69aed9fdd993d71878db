# Feature map guide

The feature map is the maintained source for verifying a project's user-facing behavior. It lives beside the generated verification workflow, usually in a `features/` directory. A reader opens the index before driving the app, then follows the matching feature file.

Keep implementation details out of the map. Name only user paths, stable handles, required state, exact commands, and observable proof.

## Layout

```text
features/
├── README.md        index plus baseline preconditions and driving conventions
├── <feature-a>.md
└── <feature-b>.md
```

The README states:

- Baseline preconditions: launch URL or command, disposable data directory, seed data, required `PATH` entries, and the doctor check that must pass.
- Driving conventions: where recipes start from, how to select elements, and which command runs browser versus terminal actions.
- Proof and skip reporting: what counts as proof for each surface, and how to report an unreachable path.
- The feature index, one line per feature file.

## Feature file contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with <harness>` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and an observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an accessibility snapshot and a screenshot with the app identity visible.
- CLI proof includes the command, stdout, stderr, and exit code.
- Mutation proof includes a read-only second view of the stored value.
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Never report a skipped entry point as verified through a different path.

## Worked example

A map for a small notes app driven by a generic `verify-app` harness.

`features/README.md`:

```markdown
# Notes verification map

## Baseline preconditions

- Launch Notes at `http://127.0.0.1:4173` with a disposable data directory.
- Set `NOTES_DATA_DIR=/tmp/notes-verify-$RUN_ID` so concurrent runs do not share state.
- Seed notes titled `Quarterly plan` and `Grocery list`.
- Run `verify-app doctor` and require the expected URL and data directory.

## Features

- [Create a note](./create-note.md) covers creation, cancellation, persistence, and cleanup.
- [Search notes](./search.md) covers matching, empty, and clear states.
```

`features/create-note.md`:

```markdown
# Create a note

Create note lets a user save a titled note, cancel an unfinished draft, and confirm the saved note from a second view.

## Sub-features

- `create-open` opens a blank editor.
- `create-save` persists a title and body.
- `create-cancel` discards an unfinished draft.

## How to get to it (user POV)

- Choose the `New note` button in the toolbar.
- Press `n` while focus is outside an editable field.

## Driving it with verify-app

Preconditions:

- Notes is healthy at `http://127.0.0.1:4173`.
- No note is titled `Release checklist`.

- **Open editor.** Choose `New note`. Run `verify-app browser click --role button --name "New note"`. A form named `Note editor` appears.
- **Save note.** Run `verify-app browser fill --role textbox --name "Title" --value "Release checklist"` then `verify-app browser click --role button --name "Save note"`. A status named `Note saved` appears.
- **Confirm persistence.** Run `verify-app browser click --role link --name "All notes"`. The list shows a `Release checklist` link.

## Gotchas

- Pressing `n` while a textbox has focus types the character instead of opening the editor.
- A save status alone is not proof. Reopen the note from the list.
```

Replace the harness name and commands with the repository's actual harness. The four H2 sections, the `Preconditions:` line, and the labeled action bullets are the stable contract.
