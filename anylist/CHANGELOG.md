## 1.7.3-storetags.5

Fixes the route wrapper added in .4, which broke `res.send()`.

`app.get` is **dual-purpose** in Express: with a single argument it reads an
application setting, and Express calls it internally -- `res.send()` asks for
`"json spaces"` and `"json escape"`. Wrapping that form turned a settings read
into a route registration and returned the app object instead of the value, so
every response failed with `Cannot read properties of undefined (reading
'headersSent')`.

Only actual routes are wrapped now: two or more arguments, the last a function.

## 1.7.3-storetags.4

Log in ONCE and keep the session, instead of a fresh login plus a full
user-data fetch on every HTTP request. Nine routes went through `initialize()`
and Home Assistant calls them constantly -- a coordinator poll, a trigger on
every list-signature change, and a 30-minute sweep reading five lists one at a
time. That was roughly 1,700 logins a day for data that changes a few times a
day.

On 2026-08-26 AnyList began answering `/data/user-data/get` with 401. The
upstream client refreshes its token and retries with no cap, so this became 33
authentication attempts per boot aimed at the service already refusing us,
until a request tarpitted (TLS never completed, socket held 959 seconds), the
rejection went unhandled and node exited -- then `boot: auto` restarted it.

Three fixes:

- **One session, reused**, with an in-flight guard so concurrent requests share
  a single login rather than starting five.
- **A circuit breaker.** After 3 consecutive failures, refuse to call AnyList
  for 5 minutes. Retrying is what turns a throttle into a block.
- **Async route errors can no longer kill the process.** Express 4 does not
  catch a rejected promise from an async handler; handlers are now wrapped once
  at registration, so a route added later cannot reintroduce the crash. A
  failure returns 503 -- "upstream is refusing us", not "this is a bug".

## 1.7.3-storetags.3

Corrects .2, which did not work.

.2 tried to give an already-existing item `storeIds` by re-sending a whole
`ListItem` through the `update-list-item` handler. **AnyList accepts that
operation, reports success, and silently applies only a subset of fields.**
`storeIds` and `productUpc` are not in that subset. Verified twice -- through
this add-on, and from an independent Python client -- so it is AnyList's
behaviour, not an encoding bug here.

Both fields are honoured **only at creation**. So a revive that needs either is
now done as create-then-remove: add a fresh item carrying the fields, then
delete the old checked one. Create first on purpose. If the create fails,
nothing is lost; delete-first would drop the item outright. If the delete fails
instead, the leftover is a checked duplicate -- visible and harmless.

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


