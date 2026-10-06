# Contract E3: Hub-local browse collections

Collections are optional Hub-owned browse metadata. They live at
`intake/collections.yaml`, outside every imported skill root, and do not alter
canonical skill bytes, routing metadata, release membership, or SkillVersion
hashes. Collection-based routing is not defined by this contract.

## Configuration

The YAML document has exactly these top-level fields:

```yaml
schema_version: 1
revision: 1
collections:
  - key: engineering
    label: Engineering
    parent: null
memberships:
  ega/example: [engineering]
```

`revision` is a positive operator-controlled revision. Collection keys are
stable lower-case ASCII keys matching `[a-z0-9][a-z0-9-]*`; labels are display
metadata. `parent` is optional and may reference another collection key.
Membership lists contain sorted, unique collection keys. A skill may belong to
multiple collections. Moving a skill between collections is a browse metadata
change only.

## Validation

`hub collections validate --hub <hub>` builds the fresh exact Hub catalog and
returns an `ega.collection-validation` envelope. The envelope includes the
collection revision, source file digest, exact catalog `{skill_id: version_hash}`
map, normalized browse projection, and deterministic diagnostics.

Validation blocks on invalid keys, duplicate normalized keys, missing parents,
parent cycles, unknown collection keys, duplicate or unsorted memberships, and
skill IDs that are malformed or absent from the chosen Hub catalog. An absent
collections file is the valid empty collection set so existing Hubs remain
buildable. A blocked validation returns the complete report and CLI exit code
1; it never mutates the Hub or filters the catalog.
