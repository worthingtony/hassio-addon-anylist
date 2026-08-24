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


