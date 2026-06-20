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

import { appendFields, disableDataCollection, downloadDataCollectionLog, enableDataCollection, getLog, registerDataCollectionGlobals } from '../lib/dataCollectionLog';
import { RawFieldData } from '../types';

function record(id: string): RawFieldData {
    return { id } as unknown as RawFieldData;
}

beforeEach(async () => {
    await chrome.storage.session.clear();
    await chrome.storage.local.clear()
        ; (chrome.downloads.download as jest.Mock).mockClear();
});

describe('dataCollectionLog - appendFields / getLog', () => {
    it('appends batches and preserves order across calls', async () => {
        await appendFields([record('a'), record('b')]);
        await appendFields([record('c')]);

        const log = await getLog();
        expect(log.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    });

    it('is a no-op for an empty batch', async () => {
        await appendFields([]);
        expect(await getLog()).toHaveLength(0);
    });

    it('imposes no artificial record cap', async () => {
        const many = Array.from({ length: 1000 }, (_, i) => record(`x${i}`));
        await appendFields(many);
        expect(await getLog()).toHaveLength(1000);
    });

    it('returns an empty array when nothing has been logged', async () => {
        expect(await getLog()).toEqual([]);
    });
});

describe('dataCollectionLog - enable / disable flag', () => {
    it('sets the dataCollectionEnabled local flag', async () => {
        await enableDataCollection();
        let data = await chrome.storage.local.get('dataCollectionEnabled');
        expect(data.dataCollectionEnabled).toBe(true);

        await disableDataCollection();
        data = await chrome.storage.local.get('dataCollectionEnabled');
        expect(data.dataCollectionEnabled).toBe(false);
    });
});

describe('dataCollectionLog - download', () => {
    it('downloads dataset.json as a base64 JSON data URI containing the log', async () => {
        await appendFields([record('zzz')]);

        await downloadDataCollectionLog();

        expect(chrome.downloads.download).toHaveBeenCalledTimes(1);
        const options = (chrome.downloads.download as jest.Mock).mock.calls[0][0] as {
            url: string;
            filename: string;
        };
        expect(options.filename).toBe('dataset.json');
        expect(options.url.startsWith('data:application/json;base64,')).toBe(true);

        const base64 = options.url.split(',')[1];
        const parsed = JSON.parse(atob(base64)) as RawFieldData[];
        expect(parsed).toHaveLength(1);
        expect(parsed[0].id).toBe('zzz');
    });

    it('exports an empty array when the log is empty', async () => {
        await downloadDataCollectionLog();

        const options = (chrome.downloads.download as jest.Mock).mock.calls[0][0] as { url: string; };
        const parsed = JSON.parse(atob(options.url.split(',')[1])) as RawFieldData[];
        expect(parsed).toEqual([]);
    });
});

describe('dataCollectionLog - console globals', () => {
    it('registers callable globals that drive the flag', async () => {
        registerDataCollectionGlobals();

        expect(typeof globalThis.enableDataCollection).toBe('function');
        expect(typeof globalThis.disableDataCollection).toBe('function');
        expect(typeof globalThis.downloadDataCollectionLog).toBe('function');

        await globalThis.enableDataCollection();
        const data = await chrome.storage.local.get('dataCollectionEnabled');
        expect(data.dataCollectionEnabled).toBe(true);
    });
});
