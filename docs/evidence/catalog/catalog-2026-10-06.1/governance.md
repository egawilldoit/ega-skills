# Governance — catalog-2026-10-06.1

## Namespace adoption model (unchanged)

`mattpocock`, `anthropic` and `vercel` remain **local-owned** namespaces, not
adopted Git sources, exactly as in every prior catalog release. The platform
forbids mixing an adopted Git source with owned routing-metadata trees in one
namespace, and `ega.yaml` routing metadata must live inside the namespace. This
release therefore reproduces the existing governance model rather than
re-architecting it.

Consequence, stated plainly: for the local-owned namespaces the Hub stores the
selected-tree and vendored-snapshot digests, and the **exact upstream commit is
recorded as the governed pin in this evidence record**, not in
`sources.lock.yaml`. `sources.lock.yaml` pins only the Git-adopted source
(`egawilldoit-skills` @ `f48e0ed8197bdfddae3a4c6ae5a12ca6f6f085df`, unchanged).
The byte-identity proof in `source.md` is what binds the local-owned Matt tree to
the pin.

## License / provenance

- Matt: MIT (repo-level `LICENSE`), byte-identical across both pins.
- Anthropic: Apache-2.0 per-skill `LICENSE.txt`; one documented D1 description
  repair, carried forward unchanged.
- Vercel: MIT (README § License); four documented D1 `name` repairs, carried
  forward unchanged.
- EGA: `LICENSE`, `THIRD_PARTY_NOTICES.md`, `upstream-sources.json`, 66/66 entries.

## Carried-forward EGA routing overlays — re-decided, not copied blindly

Both existing Matt overlays were re-examined against the v1.3.1 upstream text
before being re-applied.

### `mattpocock/diagnosing-bugs` — PRESERVED, still justified

- Original reason: the collision corpus task ("never exits") has zero lexical
  overlap with the natural description, so trigger evidence was required.
- v1.3.1 description: **byte-identical** to the previous pin.
  Re-checked: the body still contains none of `never exits`, `hangs`,
  `root cause`. The lexical gap that justified the overlay is unchanged.
- v1.3.1 changed only the `CONTEXT.md` → `GLOSSARY.md` reference, which is
  orthogonal to the trigger justification.
- Decision: **preserve unchanged**. Triggers: `never exits`, `hangs`,
  `root cause`.

### `mattpocock/tdd` — PRESERVED, still justified

- Original reason: test-first build prompts must outrank planning/wayfinder
  vocabulary.
- v1.3.1 description: **byte-identical** to the previous pin. The spaced
  variant `red green refactor` is still absent from upstream prose, so the
  trigger is still supplying evidence the description does not.
- New competition considered and rejected as not requiring a change: the
  newly-graduated `implement-spec` is `disable-model-invocation: true` and can
  never auto-select (SPEC-001 §5.1.6.4), so it does not compete with `tdd` in
  automatic routing.
- Decision: **preserve unchanged**. Triggers: `test-first`,
  `red green refactor`, `red-green-refactor`.

No overlay was added, removed, or rewritten in this release.

## Documented content repair: `mattpocock/pr` (Contract D1)

### The defect

Upstream `pr/SKILL.md` at `24fe0ef7` carries:

```yaml
metadata:
  credits:
    skill: show-me
    author: Dex Horthy
    organisation: Humanlayer
    url: "https://github.com/humanlayer/skills/..."
```

The portable Agent Skills specification (agentskills.io, §`metadata` field)
defines `metadata` as **"a map from string keys to string values"**. The upstream
value is a nested mapping, so it is **non-conformant with the portable format
itself**, not merely with EGA. SPEC-001 §5.1.6 freezes the same type, so the
strict V1 schema rejects the skill with `E_SKILL_FRONTMATTER_INVALID` and the
A1 plan is BLOCKED.

EGA is correct and upstream is the non-conformant party. The correct fix is a
governed, reviewed repair of the content — **not** a relaxation of the frozen
schema, which SPEC-001 §5.1.6.3 requires to reject unknown/invalid portable
fields rather than silently drop them.

### Why D1 and not a schema amendment

Amending SPEC-001 to accept nested `metadata` would make EGA *less* conformant
with the very portable format EGA implements. The frozen-contract amendment path
was therefore rejected on the merits, not merely for scope reasons.

### The repair actually applied

Resolved through the existing Contract D1 owned-derivation path
(`hub intake stage` on the BLOCKED plan → reviewed `ega.derivation-patch` →
`hub intake derive` → `review` → `apply`). No upstream file was edited in
place; the derivation stage records the exact input digest and the exact
replacement.

| field | value |
|---|---|
| upstream input digest | `sha256:ab63f1cf78647389edcd386c9427c5dfca27ed2836930c24773ffee834c19bcd` |
| repaired file digest | `sha256:251c58e16de82f462b1c43065ddf5b774fb5f7a4b4f1848b04d7e04792288246` |
| derived SkillVersion | `sha256:43174df8327ef089949f5dce65bc2bc893d8aa280f3efdb91092a67633f59adc` |
| rule_version | `catalog-matt-v131-pr-nested-metadata-1` |

The patch removes **only** the unsupported nested `metadata` block. `name`,
`description` and the entire instruction body are byte-identical to upstream.
Attribution is not lost: `pr/CREDITS.md` ships in the same skill root,
byte-identical to upstream, carrying the same Dex Horthy / `show-me` credit.

Contract D1 sanctions exactly this repair class ("explicit field removal or
replacement, including an unsupported frontmatter field"). The repair is
license-permitted (MIT), review-bound, provenance-bound and receipted in
`hub/.intake-provenance/derivative-*.json`.

## Additions and removals

- `implement-spec`, `retro` (user-invoked) and `pr` (model-invoked) were adopted
  byte-identical to upstream, **without** added EGA metadata — see `routing.md`
  for why, including the recorded limitation on `pr`.
- `resolving-merge-conflicts` was **not** retained and **no alias** was created.
  Nothing in the frozen contracts requires a compatibility alias for a withdrawn
  third-party skill, and manufacturing one would misrepresent upstream.

## Third-party byte integrity

For all 27 selected Matt roots, every file present upstream is byte-identical to
the git blob at `24fe0ef7`. The only non-upstream files anywhere in the Matt
tree are the two governed `ega.yaml` overlays. Proven: 0 mismatches, 0
unexpected extra files.