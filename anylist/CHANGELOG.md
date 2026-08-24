## 1.7.3-storetags.2

Fixes a real gap in .1: `storeIds` and `productUpc` were only attached when an
item was **created**.

`addItem()` does not always create. If a matching item exists and is checked,
it revives that item instead of adding a duplicate -- which is the common case
for anything the household has bought before. Those revived items got neither
field, so the reconciler could not tell they came from Grocy and would never
book the purchase back, and an item bound for a specialty store stayed untagged
and invisible in its filter.

`Item.save()` cannot fix it: it emits one per-field operation per changed
property, keyed by handler id, and no handler exists for `storeIds`. The
`update-list-item` handler takes a whole `ListItem`, so a revived item is now
re-sent with the augmented encoding.

Found by verifying state rather than trusting the log -- a run reported "added
6" while the list grew by 5.

## 1.7.3-storetags.1

Fork of kevdliu/hassio-addon-anylist. Adds AnyList's store fields, which the
upstream JS `Item` wrapper drops even though the protobuf schema has carried
them for years -- `ListItem.storeIds` is field 16, `productUpc` is field 30,
and both are already described in the `anylist` package's `definitions.json`.

- `GET /items` now returns `storeIds` and `productUpc` per item.
- `POST /add` accepts `storeIds` (array of store ids) and `productUpc`. Both are
  set at creation, in the same operation, so there is no follow-up update that
  can fail and leave an item half-tagged.
- `GET /stores` is new: every store and store filter, with the list each belongs
  to and the `includesUnassignedItems` flag.

That flag is the point. AnyList's general-grocery filters set it, so an untagged
item shows up there regardless. Specialty filters do not -- an item that does
not name the store is invisible in its view. Without `storeIds` nothing can
route an item to Empire Fish or Wild Fork.

The `anylist` npm package is unmodified. Reads come from the decoded protobuf it
already caches; writes augment the object `Item._encode()` hands to the protobuf
constructor, which accepts any field the schema knows.


