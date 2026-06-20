// Copyright 2021 Palantir Technologies
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// jest-webextension-mock only models MV2 surfaces. These shims add the MV3 APIs
// the migrated extension relies on: chrome.storage.session, chrome.action, and
// chrome.alarms. They run after jest-webextension-mock (see jest.config.js
// setupFiles order) so global.chrome already exists.

function resolveKey(store, key) {
    if (key === null || key === undefined) {
        return { ...store };
    }
    if (typeof key === 'string') {
        return { [key]: store[key] };
    }
    if (Array.isArray(key)) {
        return key.reduce((acc, curr) => {
            acc[curr] = store[curr];
            return acc;
        }, {});
    }
    if (typeof key === 'object') {
        return Object.keys(key).reduce((acc, curr) => {
            acc[curr] = store[curr] === undefined ? key[curr] : store[curr];
            return acc;
        }, {});
    }
    throw new Error('Wrong key given');
}

function makeStorageArea() {
    let store = {};
    return {
        get: jest.fn((key, cb) => {
            const result = resolveKey(store, key);
            if (cb !== undefined) {
                return cb(result);
            }
            return Promise.resolve(result);
        }),
        set: jest.fn((payload, cb) => {
            Object.keys(payload).forEach((key) => (store[key] = payload[key]));
            if (cb !== undefined) {
                return cb();
            }
            return Promise.resolve();
        }),
        remove: jest.fn((id, cb) => {
            const keys = typeof id === 'string' ? [id] : id;
            keys.forEach((key) => delete store[key]);
            if (cb !== undefined) {
                return cb();
            }
            return Promise.resolve();
        }),
        clear: jest.fn((cb) => {
            store = {};
            if (cb !== undefined) {
                return cb();
            }
            return Promise.resolve();
        }),
    };
}

if (global.chrome) {
    if (global.chrome.storage && !global.chrome.storage.session) {
        global.chrome.storage.session = makeStorageArea();
    }

    if (!global.chrome.action) {
        global.chrome.action = {
            setBadgeText: jest.fn(() => Promise.resolve()),
            setBadgeBackgroundColor: jest.fn(() => Promise.resolve()),
            setIcon: jest.fn(() => Promise.resolve()),
            setTitle: jest.fn(() => Promise.resolve()),
        };
    }

    if (!global.chrome.alarms) {
        global.chrome.alarms = {
            create: jest.fn(() => Promise.resolve()),
            clear: jest.fn(() => Promise.resolve(true)),
            clearAll: jest.fn(() => Promise.resolve(true)),
            get: jest.fn(() => Promise.resolve(undefined)),
            getAll: jest.fn(() => Promise.resolve([])),
            onAlarm: {
                addListener: jest.fn(),
                removeListener: jest.fn(),
                hasListener: jest.fn(),
            },
        };
    }
}
