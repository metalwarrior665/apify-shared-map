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
