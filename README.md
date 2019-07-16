## apify-shared-map

This is extension of [big-map-simple](https://www.npmjs.com/package/big-map-simple) for synchronizing data between multilple actor runs on [apify-js](https://github.com/apifytech/apify-js). Its usage is mainly for approximate synchonization since syncing often may be costly.

### Synchonization
It uses key-value stores to hold the state and uses locks to synchronize between multiple runs. When actor wants to synchonise, it will lock the store, load its content, synchronize it with its own map and then save it back to the store (overwritting what was there) and finally unlocks it. If the store is already locked, the sync() method will do nothing which prevents deadlocks (although it can still very rarely happen that both actors will lock in the same time and and one will overwrite the update from other). So the synchornization is always approximate and the sync() method should be scheduled.

### Use-cases
Keys should be strings but values can be arbitrary javascript values that can be stringified.

There is now one hardcoded setting that if there is already a value in the key, we will not overwrite it with value `enqueued` in the automatic sync process.

```
const Apify = require('apify');
const assert = require('assert');

const ApifySharedMap = require('./src/main.js');

Apify.main(async () => {
    const initialState = [];
    for (let i = 0; i < 1000; i++) {
        initialState.push(`KEY-${i}`);
    }

    const store = await Apify.openKeyValueStore('test-store');
    await store.setValue('INITIAL-TEST', initialState);

    const map = new ApifySharedMap(Apify, { storeId: 'test-store', storeRecordSize: 100 });
    await map.initialize();

    assert.equal(map.size, 1000);

    map.set('KEY-1', 'processed');

    assert.equal(map.get('KEY-1'), 'processed');
    assert.equal(map.get('KEY-2'), 'enqueued');

    for (let i = 500; i < 1500; i++) {
        map.set(`KEY-${i}`, 'enqueued');
    }
    await map.sync();

    for (let i = 750; i < 2000; i++) {
        if (map.get(`KEY-${i}`) === 'enqueued') {
            map.set(`KEY-${i}`, 'processed')
        } else {
            map.set(`KEY-${i}`, 'enqueued');
        }
    }
    await map.sync();
});
```