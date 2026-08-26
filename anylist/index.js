const AnyList = require("anylist");
const express = require("express");
const minimist = require("minimist");

const args = minimist(process.argv.slice(2));

const PORT = args["port"] || process.env.PORT || 8080;
const EMAIL = args["email"] || process.env.EMAIL;
const PASSWORD = args["password"] || process.env.PASSWORD;
const IP_FILTER = args["ip-filter"] || process.env.IP_FILTER;
const DEFAULT_LIST = args["default-list"] || process.env.DEFAULT_LIST;
const CREDENTIALS_FILE = args["credentials-file"] || process.env.CREDENTIALS_FILE;

// ---------------------------------------------------------------------------
// ONE session, reused.
//
// This function used to build a new AnyList client, log in, and fetch the whole
// user's lists on EVERY HTTP request. Nine routes call it, and the Home
// Assistant side calls those routes constantly: a coordinator poll, a trigger
// on every list-signature change, and a periodic sweep that reads five lists
// one at a time. Each of those was a fresh login plus a full user-data fetch.
//
// On 2026-08-26 AnyList started answering /data/user-data/get with 401. The
// upstream client responds to a 401 by refreshing its token and retrying, with
// no cap -- 33 refresh cycles in one boot, each one a new authentication
// request aimed at the service already refusing us. A request eventually
// tarpitted (TCP connected in 23ms, TLS never completed, socket held for 959
// seconds), the rejection went unhandled, node died, and the add-on restarted
// on boot:auto to do it again.
//
// Logging in once and keeping the session removes ~99% of that traffic. The
// rest of this block makes sure that when AnyList does push back, we degrade to
// stale data instead of a crash loop.
// ---------------------------------------------------------------------------

const MAX_CONSECUTIVE_FAILURES = 3;
const COOLDOWN_MS = 5 * 60 * 1000;

let client = null;          // the live session
let clientPromise = null;   // in-flight login, so concurrent requests share one
let consecutiveFailures = 0;
let cooldownUntil = 0;

async function getClient() {
    if (client) {
        return client;
    }
    // Without this guard, five sweep requests arriving together would each
    // start their own login -- which is the storm this change exists to stop.
    if (!clientPromise) {
        clientPromise = (async () => {
            const any = new AnyList({email: EMAIL, password: PASSWORD, credentialsFile: CREDENTIALS_FILE});
            await any.login(false);
            await any.getLists();
            return any;
        })();
        clientPromise
            .then(any => { client = any; console.log("AnyList session established"); })
            .catch(() => {})
            .finally(() => { clientPromise = null; });
    }
    return clientPromise;
}

async function initialize(onInitialized) {
    if (Date.now() < cooldownUntil) {
        const secs = Math.ceil((cooldownUntil - Date.now()) / 1000);
        throw new Error(`AnyList cooldown: ${secs}s remaining after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
    }

    let any;
    try {
        any = await getClient();
    } catch (err) {
        noteFailure(err, "login");
        throw err;
    }

    try {
        const result = await onInitialized(any);
        consecutiveFailures = 0;
        return result;
    } catch (err) {
        // Drop the session: a 401 here means this one is no longer accepted,
        // so the next request logs in afresh -- ONCE, not in a loop.
        client = null;
        noteFailure(err, "request");
        throw err;
    }
}

function noteFailure(err, phase) {
    consecutiveFailures += 1;
    console.error(`AnyList ${phase} failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err && err.message}`);
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        cooldownUntil = Date.now() + COOLDOWN_MS;
        consecutiveFailures = 0;
        console.error(`AnyList is refusing us. Backing off for ${COOLDOWN_MS / 60000} minutes ` +
                      `rather than retrying -- retrying is what turns a throttle into a block.`);
    }
}

async function getLists() {
    return initialize(async (any) => {
        return any.lists.map(list => list.name);
    });
}

function normalizeListName(name) {
    return name.trim().toUpperCase();
}

function getListByName(any, name) {
    return any.lists.find(l => normalizeListName(l.name) === normalizeListName(name));
}

/*
 * FORK ADDITION: storeIds and productUpc.
 *
 * AnyList's schema has carried both for years -- ListItem.storeIds is field 16
 * and productUpc is field 30, and definitions.json in the anylist package
 * already describes them. What is missing is the JS Item wrapper, which models
 * nine fields and silently drops the rest on the way in and out.
 *
 * So this does not touch the anylist package. Reads come from the decoded
 * protobuf the library already caches; writes augment the object Item._encode
 * hands to the protobuf constructor, which accepts any field the schema knows.
 *
 * Why it matters: AnyList store filters split into two kinds. General ones set
 * includesUnassignedItems, so an untagged item shows up there anyway. Specialty
 * ones do not -- an item that does not name the store is invisible in its view.
 * Without storeIds, nothing can route an item to Empire Fish or Wild Fork.
 */
async function rawItemFields(any) {
    // The library caches the decoded PBUserDataResponse; ask for the cached
    // copy rather than forcing another round trip.
    let data = await any._getUserData(false);
    let index = new Map();
    let response = data && data.shoppingListsResponse;
    if (!response) {
        return index;
    }

    for (let list of [...(response.newLists || []), ...(response.modifiedLists || [])]) {
        for (let item of (list.items || [])) {
            index.set(item.identifier, {
                storeIds: item.storeIds || [],
                productUpc: item.productUpc || null
            });
        }
    }

    return index;
}

/*
 * Make one item carry storeIds and productUpc when it is encoded.
 *
 * Item._encode() builds a plain object and passes it to the ListItem protobuf
 * constructor. Adding fields to that object is enough -- the schema already
 * knows them -- so this wraps _encode instead of reimplementing the whole
 * add operation.
 */
function attachExtraFields(item, updates) {
    let storeIds = Array.isArray(updates["storeIds"]) ? updates["storeIds"] : null;
    let productUpc = updates["productUpc"] || null;
    if (!storeIds && !productUpc) {
        return item;
    }

    let encode = item._encode.bind(item);
    item._encode = () => {
        let encoded = encode();
        if (storeIds) {
            encoded.storeIds = storeIds;
        }
        if (productUpc) {
            encoded.productUpc = productUpc;
        }
        return encoded;
    };

    return item;
}

/*
 * FORK ADDITION: giving an ALREADY-EXISTING item storeIds / productUpc.
 *
 * You cannot. Both fields are only honoured when an item is created.
 *
 * Item.save() was never going to work -- it emits one per-field operation per
 * changed property, keyed by handler id, and no handler exists for storeIds.
 * The obvious next move, re-sending a whole ListItem through the
 * "update-list-item" handler, was tried and VERIFIED NOT TO WORK: AnyList
 * accepts the operation, returns success, and silently applies only a subset
 * of fields. storeIds and productUpc are not in it. That was confirmed twice,
 * once through this add-on and once from an independent Python client, so it
 * is AnyList's behaviour and not a bug in the encoding here.
 *
 * That matters because addItem() does not always create. When a matching item
 * exists and is checked it revives that item, which is the common case for
 * anything the household has bought before -- and this list carries years of
 * checked history. A revived item with no productUpc is invisible to the
 * reconciler, so the purchase never gets booked back into Grocy, and one bound
 * for a specialty store stays untagged and invisible in its filter.
 *
 * So a revive that needs either field is done as create-then-remove: add a
 * fresh item carrying the fields, then delete the old checked one. Create
 * first on purpose -- if the create fails nothing has been lost, whereas
 * delete-first would drop the item on a failure. If the delete fails instead,
 * the leftover is a checked duplicate, which is visible and harmless.
 */
async function replaceCheckedItem(any, list, oldItem, itemName, updates) {
    let category = lookupItemCategory(any, list.identifier, itemName);
    let newItem = any.createItem({name: itemName, categoryMatchId: category});
    populateItemUpdates(newItem, updates);
    newItem.checked = false;
    attachExtraFields(newItem, updates);

    await list.addItem(newItem);
    try {
        await list.removeItem(oldItem);
    } catch (err) {
        console.log(`Could not remove superseded item ${oldItem.identifier}: ${err}`);
    }
}

async function getStores() {
    return initialize(async (any) => {
        let data = await any._getUserData(false);
        let response = data && data.shoppingListsResponse;
        if (!response) {
            return null;
        }

        let listNames = new Map();
        for (let list of any.lists) {
            listNames.set(list.identifier, list.name);
        }

        let stores = [];
        let filters = [];
        for (let listResponse of (response.listResponses || [])) {
            let listName = listNames.get(listResponse.listId) || null;
            for (let store of (listResponse.stores || [])) {
                stores.push({
                    id: store.identifier,
                    name: store.name,
                    list: listName,
                    sortIndex: store.sortIndex || 0
                });
            }

            for (let filter of (listResponse.storeFilters || [])) {
                filters.push({
                    id: filter.identifier,
                    name: filter.name,
                    list: listName,
                    storeIds: filter.storeIds || [],
                    // The distinction that decides whether tagging is optional.
                    includesUnassignedItems: filter.includesUnassignedItems || false,
                    showsAllItems: filter.showsAllItems || false
                });
            }
        }

        return {stores: stores, filters: filters};
    });
}

async function getItems(listName) {
    return initialize(async (any) => {
        let list = getListByName(any, listName);
        if (!list) {
            return null;
        }

        let extra = await rawItemFields(any);
        let items = list.items
        return items
            .map(item => {
                let more = extra.get(item.identifier) || {};
                return {
                    name: item.name,
                    id: item.identifier,
                    checked: item.checked || false,
                    notes: item.details || "",
                    storeIds: more.storeIds || [],
                    productUpc: more.productUpc || null
                };
            });
    });
}

async function removeItemByName(listName, itemName) {
    return initialize(async (any) => {
        let list = getListByName(any, listName);
        if (!list) {
            return 400;
        }

        let item = list.getItemByName(itemName);
        if (item) {
            await list.removeItem(item);
            return 200;
        } else {
            return 304;
        }
    });
}

async function removeItemById(listName, itemId) {
    return initialize(async (any) => {
        let list = getListByName(any, listName);
        if (!list) {
            return 400;
        }

        let item = list.getItemById(itemId);
        if (item) {
            await list.removeItem(item);
            return 200;
        } else {
            return 304;
        }
    });
}

function lookupItemCategory(any, listId, itemName) {
    let recentItems = any.getRecentItemsByListId(listId);
    if (!recentItems) {
        return null;
    }

    let recentItem = recentItems.find((item) => {
        return item.name.toLowerCase() == itemName.toLowerCase();
    });

    if (!recentItem) {
        return null;
    }

    return recentItem.categoryMatchId;
}

function populateItemUpdates(item, updates) {
    if ("name" in updates) {
        item.name = updates["name"];
    }

    if ("checked" in updates) {
        item.checked = updates["checked"];
    }

    if ("notes" in updates) {
        item.details = updates["notes"];
    }
}

async function addItem(listName, itemName, updates) {
    return initialize(async (any) => {
        let list = getListByName(any, listName);
        if (!list) {
            return 400;
        }

        let item = list.getItemByName(itemName);
        if (!item) {
            let category = lookupItemCategory(any, list.identifier, itemName);
            let newItem = any.createItem({name: itemName, categoryMatchId: category});
            populateItemUpdates(newItem, updates);
            newItem.checked = false;
            // Set at creation, in the same operation. There is no follow-up
            // update that can fail and leave the item half-tagged.
            attachExtraFields(newItem, updates);
            await list.addItem(newItem);
            return 200;
        } else if (item.checked) {
            let wantsExtras = (Array.isArray(updates["storeIds"]) && updates["storeIds"].length)
                || updates["productUpc"];
            if (wantsExtras) {
                // Cannot be set on an existing item; replace it instead.
                await replaceCheckedItem(any, list, item, itemName, updates);
                return 200;
            }

            populateItemUpdates(item, updates);
            item.checked = false;
            await item.save();
            return 200;
        } else {
            return 304;
        }
    });
}

async function updateItem(listName, itemId, updates) {
    return initialize(async (any) => {
        let list = getListByName(any, listName);
        if (!list) {
            return 400;
        }

        let item = list.getItemById(itemId);
        if (!item) {
            return 400;
        }

        populateItemUpdates(item, updates);
        await item.save();
        return 200;
    });
}

async function checkItem(listName, itemName, checked) {
    return initialize(async (any) => {
        let list = getListByName(any, listName);
        if (!list) {
            return 400;
        }

        let item = list.getItemByName(itemName);
        if (!item) {
            return 400;
        }

        if (item.checked == checked) {
            return 304;
        }

        item.checked = checked;
        await item.save();
        return 200;
    });
}

function getListName(list) {
    return list || DEFAULT_LIST;
}

function enforceRequestSource(req, res) {
    if (!IP_FILTER) {
        return true;
    }

    let ip = req.socket.remoteAddress
    if (ip.startsWith(IP_FILTER)) {
        return true;
    }

    res.sendStatus(403);
    return false;
}

const app = express();
app.use(express.json());

// Express 4 does NOT catch a rejected promise from an async handler: it becomes
// an unhandled rejection, and node's default is to kill the process. That is
// the literal crash in the 2026-08-26 logs --
// `triggerUncaughtException(err, true /* fromPromise */)`. Wrapping here rather
// than in nine handlers means a route added later cannot reintroduce it.
for (const method of ["get", "post"]) {
    const register = app[method].bind(app);
    app[method] = (...args) => {
        // `app.get` is DUAL-PURPOSE: with a single argument it reads an
        // application setting, and Express calls it internally -- res.send()
        // asks for "json spaces" and "json escape". Wrapping that form turns a
        // settings read into a route registration and hands the caller the app
        // object instead of the value. Only wrap an actual route: two or more
        // arguments, the last of which is a handler.
        const handler = args[args.length - 1];
        if (args.length < 2 || typeof handler !== "function") {
            return register(...args);
        }
        const path = args[0];
        const rest = args.slice(0, -1);
        return register(...rest, async (req, res, next) => {
            try {
                await handler(req, res, next);
            } catch (err) {
                console.error(`${method.toUpperCase()} ${path} failed: ${err && err.message}`);
                if (res && !res.headersSent) {
                    // 503, not 500: this is "upstream is refusing us, try
                    // later", and the caller should back off rather than treat
                    // it as a bug in the request.
                    res.sendStatus(503);
                }
            }
        });
    };
}

app.get("/lists", async (req, res) => {
    if (!enforceRequestSource(req, res)) {
        return;
    }

    let lists = await getLists();
    let response = {
        lists: lists
    };

    res.status(200);
    res.header("Content-Type", "application/json");
    res.send(JSON.stringify(response));
});

app.get("/items", async (req, res) => {
    if (!enforceRequestSource(req, res)) {
        return;
    }

    let listName = getListName(req.query.list);
    if (!listName) {
        res.sendStatus(400);
        return;
    }

    let items = await getItems(listName);
    if (items == null) {
        res.sendStatus(500);
        return;
    }

    let response = {
        items: items
    };

    res.status(200);
    res.header("Content-Type", "application/json");
    res.send(JSON.stringify(response));
});

app.post("/add", async (req, res) => {
    if (!enforceRequestSource(req, res)) {
        return;
    }

    let item = req.body.name;
    if (!item) {
        res.sendStatus(400);
        return;
    }

    let listName = getListName(req.body.list);
    if (!listName) {
        res.sendStatus(400);
        return;
    }

    let code = await addItem(listName, item, req.body);
    res.sendStatus(code);
});

app.get("/stores", async (req, res) => {
    if (!enforceRequestSource(req, res)) {
        return;
    }

    let result = await getStores();
    if (result == null) {
        res.sendStatus(500);
        return;
    }

    res.status(200);
    res.header("Content-Type", "application/json");
    res.send(JSON.stringify(result));
});

app.post("/remove", async (req, res) => {
    if (!enforceRequestSource(req, res)) {
        return;
    }

    let listName = getListName(req.body.list);
    if (!listName) {
        res.sendStatus(400);
        return;
    }

    if (req.body.name) {
        let code = await removeItemByName(listName, req.body.name);
        res.sendStatus(code);
    } else if (req.body.id) {
        let code = await removeItemById(listName, req.body.id);
        res.sendStatus(code);
    } else {
        res.sendStatus(400);
    }
});

app.post("/update", async (req, res) => {
    if (!enforceRequestSource(req, res)) {
        return;
    }

    let listName = getListName(req.body.list);
    if (!listName) {
        res.sendStatus(400);
        return;
    }

    let itemId = req.body.id;
    if (!itemId) {
        res.sendStatus(400);
        return;
    }

    let code = await updateItem(listName, itemId, req.body);
    res.sendStatus(code);
});

app.post("/check", async (req, res) => {
    if (!enforceRequestSource(req, res)) {
        return;
    }

    let listName = getListName(req.body.list);
    if (!listName) {
        res.sendStatus(400);
        return;
    }

    let itemName = req.body.name;
    if (!itemName) {
        res.sendStatus(400);
        return;
    }

    let checked = req.body.checked;
    if (checked === undefined) {
        res.sendStatus(400);
        return;
    }

    let code = await checkItem(listName, itemName, checked);
    res.sendStatus(code);
});

// Last resort. Nothing above should let a rejection escape, but the upstream
// client owns its own retry loop and this add-on must not die because of it.
process.on("unhandledRejection", (err) => {
    console.error(`Unhandled rejection (ignored, not fatal): ${err && err.message}`);
});

function start() {
    if (!EMAIL || !PASSWORD) {
        console.error("Missing username or password");
        return;
    }

    app.listen(PORT, "0.0.0.0", () => {
        console.log(`Server port: ${PORT}`);

        if (IP_FILTER) {
            console.log(`IP filter: ${IP_FILTER}`);
        }

        if (DEFAULT_LIST) {
            console.log(`Default list: ${DEFAULT_LIST}`);
        }

        if (CREDENTIALS_FILE) {
            console.log(`Credentials file: ${CREDENTIALS_FILE}`);
        }
    });
}

start();
