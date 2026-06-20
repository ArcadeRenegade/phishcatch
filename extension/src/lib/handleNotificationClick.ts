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

import { AlertTypes, NotificationData } from '../types';
import { createServerAlert } from './sendAlert';
import { removeHash } from './userInfo';

// MV3 service workers are terminated after ~30s of inactivity, so notification
// metadata cannot live in a module-level Map - it would be empty by the time
// the user clicks a button, silently skipping false-positive reporting and hash
// removal. Persist it in chrome.storage.session (in-memory, MV3-native, cleared
// when the browser closes), falling back to chrome.storage.local where session
// storage is unavailable. Mirrors the dedup cache pattern in sendAlert.ts.
const NOTIFICATION_STORAGE_KEY = 'notificationData';

function getNotificationStore(): chrome.storage.StorageArea {
    return chrome.storage.session || chrome.storage.local;
}

async function getNotifications(): Promise<Record<string, NotificationData>> {
    const data = await getNotificationStore().get(NOTIFICATION_STORAGE_KEY);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    return (data[NOTIFICATION_STORAGE_KEY] as Record<string, NotificationData>) || {};
}

async function setNotifications(notifications: Record<string, NotificationData>): Promise<void> {
    await getNotificationStore().set({ [NOTIFICATION_STORAGE_KEY]: notifications });
}

export async function addNotitication(data: NotificationData) {
    const notifications = await getNotifications();
    notifications[data.id] = data;
    await setNotifications(notifications);
}

export async function handleNotificationClick(notifId: string, btnId: number) {
    const notifications = await getNotifications();
    const notificationData = notifications[notifId];
    if (notificationData) {
        const alertIconUrl = chrome.runtime.getURL('icon.png');
        if (btnId === 0) {
            const opt: chrome.notifications.NotificationCreateOptions = {
                type: 'basic',
                title: 'PhishCatch Alert',
                message: `Reporting false positive and removing matched password`,
                iconUrl: alertIconUrl,
                priority: 2,
            };

            void chrome.notifications.create(opt);

            void createServerAlert({
                referrer: '',
                url: notificationData.url,
                timestamp: new Date().getTime(),
                alertType: AlertTypes.FALSEPOSITIVE,
            });
        } else if (btnId === 1) {
            const opt: chrome.notifications.NotificationCreateOptions = {
                type: 'basic',
                title: 'PhishCatch Alert',
                message: `Removing matched password`,
                iconUrl: alertIconUrl,
                priority: 2,
            };

            void chrome.notifications.create(opt);

            void createServerAlert({
                referrer: '',
                url: notificationData.url,
                timestamp: new Date().getTime(),
                alertType: AlertTypes.FALSEPOSITIVE,
            });
        }

        void removeHash(notificationData.hash);

        // Remove the consumed entry so the persisted store does not grow unbounded.
        delete notifications[notifId];
        await setNotifications(notifications);
    }
}
