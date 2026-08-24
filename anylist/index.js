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

async function initialize(onInitialized) {
    let any = new AnyList({email: EMAIL, password: PASSWORD, credentialsFile: CREDENTIALS_FILE});
    await any.login(false);
    await any.getLists();
    return await onInitialized(any);
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
 * FORK ADDITION: set storeIds / productUpc on an item that already exists.
 *
 * Item.save() cannot do it. It emits one per-field operation per changed
 * property, keyed by a handler id, and there is no handler for storeIds. But
 * "update-list-item" takes a whole ListItem, so re-sending the augmented
 * encoding works.
 *
 * This matters more than it looks. addItem() revives an existing *checked*
 * item rather than creating a duplicate, which is the common case for anything
 * bought before. Without this, a revived item carries no productUpc, so the
 * reconciler cannot tell it came from Grocy and never books the purchase back
 * -- and if it were bound for a specialty store it would stay untagged and
 * invisible there.
 */
function randomItemId() {
    let hex = "";
    for (let i = 0; i < 32; i++) {
        hex += Math.floor(Math.random() * 16).toString(16);
    }
    return hex;
}

async function saveWholeItem(any, list, item) {
    const FormData = require("form-data");

    let op = new any.protobuf.PBListOperation();
    op.setMetadata({
        operationId: randomItemId(),
        handlerId: "update-list-item",
        userId: any.uid
    });
    op.setListId(list.identifier);
    op.setListItemId(item.identifier);
    op.setListItem(item._encode());

    let ops = new any.protobuf.PBListOperationList();
    ops.setOperations([op]);

    let form = new FormData();
    form.append("operations", ops.toBuffer());
    await any.client.post("data/shopping-lists/update", {body: form});
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
            populateItemUpdates(item, updates);
            item.checked = false;
            // A revived item must carry the same fields a new one would, or it
            // is invisible to the reconciler and to specialty store filters.
            let tagged = attachExtraFields(item, updates);
            if (tagged !== item || updates["storeIds"] || updates["productUpc"]) {
                await saveWholeItem(any, list, item);
            } else {
                await item.save();
            }
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
