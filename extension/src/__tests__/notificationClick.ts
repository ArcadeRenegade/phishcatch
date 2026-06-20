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

import { addNotitication, handleNotificationClick } from '../lib/handleNotificationClick';
import { getPasswordHashes } from '../lib/userInfo';
import { PasswordHash } from '../types';

// Let any fire-and-forget work (e.g. the voided removeHash) settle.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
});

describe('Notification click metadata persists across service-worker restarts', () => {
    it('reads metadata from storage, removes the matched hash, and consumes the entry', async () => {
        const hash: PasswordHash = {
            hash: 'matched-hash',
            salt: 'salt',
            dateAdded: Date.now(),
            username: 'user',
            hostname: 'enterprise.example',
        };
        await chrome.storage.local.set({ passwordHashes: [hash] });

        await addNotitication({ id: 'notif-1', hash: 'matched-hash', url: 'https://evil.example' });

        // Simulates the worker having been torn down: an in-memory Map would be
        // empty here, but the metadata lives in chrome.storage.session.
        await handleNotificationClick('notif-1', 0);
        await flush();

        const remaining = await getPasswordHashes();
        expect(remaining.some((h) => h.hash === 'matched-hash')).toEqual(false);

        const data = (await chrome.storage.session.get('notificationData')) as {
            notificationData?: Record<string, unknown>;
        };
        expect(data.notificationData?.['notif-1']).toBeUndefined();
    });

    it('does nothing for an unknown notification id', async () => {
        const hash: PasswordHash = {
            hash: 'keep',
            salt: 'salt',
            dateAdded: Date.now(),
            username: 'user',
            hostname: 'enterprise.example',
        };
        await chrome.storage.local.set({ passwordHashes: [hash] });

        await handleNotificationClick('does-not-exist', 0);
        await flush();

        const remaining = await getPasswordHashes();
        expect(remaining.some((h) => h.hash === 'keep')).toEqual(true);
    });
});
