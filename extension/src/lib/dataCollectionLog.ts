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

import { RawFieldData } from '../types';

// Background-side log of collected field records. Stored in chrome.storage.session
// (auto-cleared when the browser closes) and exported on demand via the console
// globals registered by registerDataCollectionGlobals().

const LOG_KEY = 'dataCollectionLog';
const FLAG_KEY = 'dataCollectionEnabled';

export async function getLog(): Promise<RawFieldData[]> {
    const data = (await chrome.storage.session.get(LOG_KEY)) as { dataCollectionLog?: RawFieldData[]; };
    return data.dataCollectionLog || [];
}

// Append a batch of records. No artificial size/record cap is applied: if the
// session quota is exceeded, the storage.session.set rejection is allowed to
// surface (the caller voids it, so it logs in the service-worker console).
export async function appendFields(fields: RawFieldData[]): Promise<void> {
    if (!fields.length) {
        return;
    }

    const log = await getLog();
    await chrome.storage.session.set({ [LOG_KEY]: log.concat(fields) });

    console.info('[phishcatch] data collection records added', fields);
}

export async function enableDataCollection(): Promise<void> {
    await chrome.storage.local.set({ [FLAG_KEY]: true });
    console.log('[phishcatch] data collection ENABLED');
}

export async function disableDataCollection(): Promise<void> {
    await chrome.storage.local.set({ [FLAG_KEY]: false });
    console.log('[phishcatch] data collection DISABLED');
}

// Serialize the log and trigger a download of dataset.json. A Base64 data URI is
// used because MV3 service workers have no URL.createObjectURL.
export async function downloadDataCollectionLog(): Promise<void> {
    const log = await getLog();
    const json = JSON.stringify(log, null, 2);

    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }
    const url = `data:application/json;base64,${btoa(binary)}`;

    await chrome.downloads.download({ url, filename: 'dataset.json', saveAs: true });
    console.log(`[phishcatch] exporting ${log.length} record(s) to dataset.json`);
}

export function registerDataCollectionGlobals(): void {
    globalThis.enableDataCollection = enableDataCollection;
    globalThis.disableDataCollection = disableDataCollection;
    globalThis.downloadDataCollectionLog = downloadDataCollectionLog;
}
