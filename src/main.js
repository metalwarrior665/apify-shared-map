
const BigMap = require('big-map-simple');

const parseMsToS = (ms) => (ms / 1000).toFixed(4);

class ApifySharedMap extends BigMap {
    constructor(Apify, options = {}) {
        super();
        const { storeId, forceCloud, storeRecordSize = 200000 } = options;
        if (!Apify || !storeId) {
            throw new Error('You have to initialize the map with "Apify" and "storeId"');
        }
        this.storeId = storeId;
        this.forceCloud = forceCloud;
        this.storeRecordSize = storeRecordSize;
        this.Apify = Apify;
        this.runId = process.env.APIFY_ACTOR_RUN_ID || Math.random().toString();
        this.globalStats = {};
        this.isLocked = false;

        // We have to unlock on migration
        Apify.events.on('migrating', async () => {
            if (this.isLocked) {
                const store = await Apify.openKeyValueStore(storeId);
                await store.setValue('LOCK', { isLocked: false, lockedRunId: null, globalStats: this.globalStats });
                console.log('SYNC --- Migrating!!! Unlocked and saved lock state');
            }
        });
    }

    digest(entries) {
        const oldSize = this.size;
        const start = Date.now();

        // We need to be careful here to not override processed with enqueued. Also efficiency is super important.
        for (const [key, value] of entries) {
            const currentEntry = this.get(key);
            if (!currentEntry) {
                this.set(key, value);
            } else if (currentEntry.value !== 'processed' && value !== 'enqueued') {
                this.set(key, value);
            }
        }
        const end = Date.now();
        const newSize = this.size;

        return { start, end, oldSize, newSize };
    }

    async load(type) {
        let fullData = [];

        // We need different logic for local and cloud runs
        let allRecords = [];
        const useCloud = this.Apify.isAtHome() || this.forceCloud
        if (useCloud) {
            allRecords = await this.Apify.client.keyValueStores.listKeys({ storeId: this.storeId }).then((res) => res.items.map((item) => item.key));
        } else {
            const store = await this.Apify.openKeyValueStore(this.storeId);
            await store.forEachKey(async (key) => {
                allRecords.push(key);
            });
        }
        
        const loadPromises = allRecords.map(async (key) => { // eslint-disable-line
            if (key.includes(type)) {
                console.log(`LOAD --- Loading data from record: ${key}`);
                let data = [];
                if (useCloud) {
                    data = await this.Apify.client.keyValueStores.getRecord({ storeId: this.storeId, key }).then((res) => res.body);
                } else {
                    const store = await this.Apify.openKeyValueStore(this.storeId);
                    data = await store.getValue(key);
                }
                fullData = fullData.concat(data);
                console.log(`LOAD --- Full data size: ${fullData.length}`);
            }
        });
        await Promise.all(loadPromises);
        return fullData;
    }

    async initialize(matchingKey = 'INITIAL') {
        const data = await this.load(matchingKey);
        const entries = data.map((item) => Array.isArray(item) ? item : [item, 'enqueued']); // eslint-disable-line
        const { start, end, oldSize, newSize } = this.digest(entries);
        console.log(`SYNC --- map initiated - map: ${oldSize} ==> ${newSize} check: ${parseMsToS(end - start)} s`);
    }

    async sync() {
        try {
            const store = await this.Apify.openKeyValueStore(this.storeId);
            const lockStats = (await this.Apify.getValue('LOCK-STATS')) || { unsuccessfulLocks: 0, successfullLocks: 0, attemptsToLastLock: 0 };
            const lockState = await store.getValue('LOCK');
            const { isLocked, lockedRunId, globalStats = { [this.runId]: lockStats } } = lockState || {};
            this.globalStats = globalStats;
            const entries = await this.load('STATE');

            if (isLocked) {
                lockStats.unsuccessfulLocks++;
                lockStats.attemptsToLastLock++;
                console.log(`SYNC --- Is locked by run: ${lockedRunId}`);
            } else {
                lockStats.successfullLocks++;
                this.globalStats[this.runId] = lockStats;
                await store.setValue('LOCK', { isLocked: true, lockedRunId: this.runId, globalStats: this.globalStats });
                this.isLocked = true;
                lockStats.attemptsToLastLock = 0;
            }
            console.log('SYNC --- lock stats');
            console.dir(lockStats);
            await this.Apify.setValue('LOCK-STATS', lockStats);
            if (isLocked) {
                return;
            }

            const { start, end, oldSize, newSize } = this.digest(entries);

            const newEntries = this.entries();
            const entriesEnd = Date.now();
            const enqueued = newEntries.filter(([key, value]) => value === 'enqueued').length;
            const processed = newEntries.filter(([key, value]) => value === 'processed').length;
            console.log(`SYNC --- entries checked - ${entries.length}, map: ${oldSize} ==> ${newSize} check: ${parseMsToS(end - start)} s, entries: ${parseMsToS(entriesEnd - end)}, enqueued: ${enqueued}, processed: ${processed}`);

            let offset = 0;
            const slices = [];
            while (offset < newEntries.length) {
                const slice = newEntries.slice(offset, offset + this.storeRecordSize);
                slices.push(slice);
                offset += this.storeRecordSize;
            }
            console.log(`SYNC --- State will be split into ${slices.length} slices`);
            const uploadStart = Date.now();
            const uploadPromises = slices.map(async (slice, i) => store.setValue(`STATE-${i}`, slice));
            await Promise.all(uploadPromises);
            const uploadEnd = Date.now();
            console.log(`SYNC --- All slices were uploaded to the store: ${uploadEnd - uploadStart} ms`);

            // We unlock at the end of sync
            await store.setValue('LOCK', { isLocked: false, lockedRunId: null, globalStats });
            console.log('SYNC --- Unlocked');
        } catch (e) {
            throw new Error(`ERROR: SYNC FAILED --- ${e}`);
        }
    }
}

module.exports = ApifySharedMap;
