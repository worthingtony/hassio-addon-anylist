# Fork: store tags

Fork of [kevdliu/hassio-addon-anylist](https://github.com/kevdliu/hassio-addon-anylist)
(GPL-3.0). Branch `store-tags`.

## Why

AnyList models stores. `ListItem.storeIds` is protobuf field 16, `productUpc` is
field 30, and the `anylist` npm package's `definitions.json` already describes
both. What drops them is the package's JS `Item` wrapper, which models nine
fields and silently discards the rest in each direction.

That mattered once Grocy started routing items. AnyList's store filters split in
two:

- **General** filters set `includesUnassignedItems`. An untagged item appears
  there anyway, so ordinary groceries need no tag at all.
- **Specialty** filters do not — Wild Fork, Empire Fish, Indian Store, Pan Asian,
  Total Wine, ACE Hardware, Home Depot. An item that does not name the store is
  **invisible** in its view.

So without `storeIds`, nothing can route an item to a specialty store, and red
snapper pushed from Grocy would never reach the Empire Fish list.

`productUpc` earns its place separately: it is the join key between the scan gun,
Grocy and AnyList. Grocy's `products.name` is `UNIQUE` and name matching is
already a known failure mode, so a barcode that survives the round trip is worth
more than it looks. It is also what makes the bridge idempotent — an item whose
UPC is already on the list is not added again — and what lets the reconciler tell
a Grocy-sent item from one the family typed in.

## What changed

Only `anylist/index.js`, plus metadata. **The `anylist` npm package is
unmodified** — no second fork.

| | |
|---|---|
| `GET /items` | now returns `storeIds` and `productUpc` |
| `POST /add` | accepts `storeIds` (array) and `productUpc` |
| `GET /stores` | new — stores and filters, with `includesUnassignedItems` |

Reads come from the decoded `PBUserDataResponse` the library already caches
(`any._getUserData(false)`), so there is no extra round trip. Writes wrap
`Item._encode()` and add the two fields to the plain object it hands the
protobuf constructor — the schema already knows them, so nothing needs
reimplementing.

Both fields are set **at creation**, inside the same `add-shopping-list-item`
operation. There is no follow-up update that can fail and leave an item
half-tagged.

### Both fields are creation-only

`storeIds` and `productUpc` **cannot be set on an item that already exists.**
`Item.save()` emits per-field operations and no handler exists for `storeIds`;
and re-sending a whole `ListItem` through `update-list-item` does not work
either — AnyList accepts it, reports success, and silently applies only a
subset of fields that excludes both. That was verified through this add-on and
independently from a Python client, so it is AnyList's behaviour.

This bites because `addItem()` does not always create. If a matching item
exists and is **checked**, it revives that one rather than adding a duplicate —
the common case for anything bought before, and this list carries years of
checked history. A revived item with no `productUpc` is invisible to the
reconciler, so the purchase is never booked back into Grocy.

So a revive that needs either field is done as **create-then-remove**: add a
fresh item carrying the fields, then delete the old checked one. Create first
deliberately — a failed create loses nothing, while delete-first would drop the
item. A failed delete leaves a checked duplicate, which is visible and
harmless.

## Deploying

The slug stays `anylist`. Home Assistant keys an install on the slug, and the
repository URL already gives this fork its own prefix, so it installs
**alongside** kevdliu's rather than replacing it.

**Both bind port 8080.** Stop the original before starting this one.

1. Add `https://github.com/tonyinwi/hassio-addon-anylist` as an add-on repository.
2. **Stop** the existing `180b202a_anylist` add-on.
3. Install this one, copy the email/password/ip_filter config across, start it.
4. Verify by behaviour, not by exit code:
   `curl -s localhost:8080/stores | head` should list stores and filters.

Rebuilding after a push needs **`ha store reload` first, then `ha apps rebuild`** —
a rebuild alone does not `git pull`. That lesson cost real time on the
barcodebuddy fork; see `barcodebuddy/FORK.md` in `kitchen-stack`.

## Upstream

`upstream` remote is set. Nothing here is worth a PR yet — the read path leans on
`any._getUserData()`, which is private, and a clean upstream change would add
`storeIds` to the `anylist` package's `Item` class instead.
