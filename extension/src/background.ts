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

import { getConfig } from './config';
import { appendFields, registerDataCollectionGlobals } from './lib/dataCollectionLog';
import { checkDOMHash, saveDOMHash } from './lib/domhash';
import { getDomainType } from './lib/getDomainType';
import { getHostFromUrl } from './lib/getHostFromUrl';
import { addNotitication, handleNotificationClick } from './lib/handleNotificationClick';
import { runInference } from './lib/inferenceRPC';
import { createServerAlert } from './lib/sendAlert';
import { showCheckmarkIfEnterpriseDomain } from './lib/showCheckmarkIfEnterpriseDomain';
import { CLEANUP_ALARM_NAME, runScheduledCleanup, timedCleanup } from './lib/timedCleanup';
import { getHashDataIfItExists, hashAndSavePassword as hashAndSavePassword, removeHash, saveUsername } from './lib/userInfo';
import { AlertTypes, CollectFieldDataContent, DomainType, DomstringContent, InferenceRequestContent, PageMessage, PasswordContent, PasswordHandlingReturnValue, PasswordHash, UsernameContent } from './types';

export async function receiveMessage(message: PageMessage): Promise<void> {
    switch (message.msgtype) {
        case 'debug': {
            break;
        }
        case 'username': {
            const content = <UsernameContent>message.content;

            if ((await getDomainType(getHostFromUrl(content.url))) === DomainType.ENTERPRISE) {
                void saveUsername(content.username);
                void saveDOMHash(content.dom, content.url);
            }
            break;
        }
        case 'password': {
            const content = <PasswordContent>message.content;
            if (content.password) {
                void handlePasswordEntry(content);
            }
            break;
        }
        case 'domstring': {
            const content = <DomstringContent>message.content;
            void checkDOMHash(content.dom, content.url);
            break;
        }
        case 'collectFieldData': {
            const content = <CollectFieldDataContent>message.content;
            void appendFields(content.fields);
            break;
        }
    }
}

//check if the site the password was entered into is a corporate site
export async function handlePasswordEntry(message: PasswordContent) {
    const url = message.url;
    const host = getHostFromUrl(url);
    const password = message.password;

    if ((await getDomainType(host)) === DomainType.ENTERPRISE) {
        if (message.save) {
            await hashAndSavePassword(password, message.username, host);
            return PasswordHandlingReturnValue.EnterpriseSave;
        }
        return PasswordHandlingReturnValue.EnterpriseNoSave;
    } else if ((await getDomainType(host)) === DomainType.DANGEROUS) {
        const hashData = await getHashDataIfItExists(password);
        if (hashData) {
            await handlePasswordLeak(message, hashData);
            return PasswordHandlingReturnValue.ReuseAlert;
        }
    } else {
        return PasswordHandlingReturnValue.IgnoredDomain;
    }

    return PasswordHandlingReturnValue.NoReuse;
}

async function handlePasswordLeak(message: PasswordContent, hashData: PasswordHash) {
    const config = await getConfig();
    const alertContent = {
        ...message,
        alertType: AlertTypes.REUSE,
        associatedHostname: hashData.hostname || '',
        associatedUsername: hashData.username || '',
    };

    void createServerAlert(alertContent);

    if (config.display_reuse_alerts) {
        // Iconurl: https://www.flaticon.com/free-icon/hacker_1995788?term=phish&page=1&position=49
        const alertIconUrl = chrome.runtime.getURL('icon.png');
        const opt: chrome.notifications.NotificationCreateOptions = {
            type: 'basic',
            title: 'PhishCatch Alert',
            message: `PhishCatch has detected enterprise password re-use on the url: ${message.url}\n`,
            iconUrl: alertIconUrl,
            requireInteraction: true,
            priority: 2,
            buttons: [{ title: 'This is a false positive' }, { title: `That wasn't my enterprise password` }],
        };

        const id = await chrome.notifications.create(opt);
        await addNotitication({ id, hash: hashData.hash, url: message.url });
    }

    if (config.expire_hash_on_use) {
        await removeHash(hashData.hash);
    }
}

// Registered synchronously at the top level so the service worker is woken by
// these events after it has been terminated for inactivity.
function setup() {
    chrome.runtime.onMessage.addListener((message: PageMessage, _sender, sendResponse) => {
        // RPC inference needs an async response: return true to keep the channel
        // open and reply via sendResponse.
        if (message && message.msgtype === 'runInference') {
            runInference(message.content as InferenceRequestContent)
                .then(sendResponse)
                .catch(() => sendResponse(false));
            return true;
        }

        // All other messages are fire-and-forget.
        void receiveMessage(message);
        return false;
    });
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    chrome.notifications.onButtonClicked.addListener(handleNotificationClick);

    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === CLEANUP_ALARM_NAME) {
            void runScheduledCleanup();
        }
    });

    registerDataCollectionGlobals();

    void showCheckmarkIfEnterpriseDomain();
    timedCleanup();
}

setup();
