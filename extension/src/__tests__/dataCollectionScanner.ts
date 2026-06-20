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

import { initDataCollection } from '../content-lib/dataCollection';

// Allow the flag read (storage.local.get().then) and synchronous scan to settle.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
    document.body.innerHTML = ''
        ; (chrome.runtime.sendMessage as jest.Mock).mockClear();
});

describe('initDataCollection - flag gating', () => {
    // NB: this test must precede the enabled test - the module keeps singleton
    // scan state, and we want to assert the disabled (default) path first.
    it('does not scan or send when the flag is disabled', async () => {
        document.body.innerHTML = `<input id="a" name="a" />`;

        initDataCollection();
        await flush();

        expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it('scans and sends collectFieldData records when the flag is enabled', async () => {
        await chrome.storage.local.set({ dataCollectionEnabled: true });
        document.body.innerHTML = `<input id="a" name="a" /><textarea id="b"></textarea>`;

        initDataCollection();
        await flush();

        expect(chrome.runtime.sendMessage).toHaveBeenCalled();
        const message = (chrome.runtime.sendMessage as jest.Mock).mock.calls[0][0] as {
            msgtype: string;
            content: { fields: unknown[]; };
        };
        expect(message.msgtype).toBe('collectFieldData');
        expect(Array.isArray(message.content.fields)).toBe(true);
        expect(message.content.fields.length).toBeGreaterThanOrEqual(2);
    });
});
