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

import { getConfig } from '../config';
import { AlertContent, AlertTypes } from '../types';
import { getId } from './clientId';
import { getUsernames } from './userInfo';

interface Alert {
    allAssociatedUsernames: string;
    alertUrl: string;
    psk: string;
    alertTimestamp: number;
    clientId: string;
    suspectedUsername?: string;
    suspectedHost?: string;
    referrer?: string;
    alertType: AlertTypes;
}

interface UnsentAlert {
    alert: Alert;
    tries: number;
}

export async function getUnsentAlerts(): Promise<UnsentAlert[]> {
    const data = (await chrome.storage.local.get('unsentAlerts')) as { unsentAlerts?: UnsentAlert[]; };
    const unsentAlerts: UnsentAlert[] = data.unsentAlerts || [];
    return unsentAlerts;
}

export async function saveUnsentAlert(newUnsentAlert: UnsentAlert) {
    let unsentAlerts = await getUnsentAlerts();
    const isOldAlert = unsentAlerts.some((currentAlert) => {
        return currentAlert.alert.alertTimestamp === newUnsentAlert.alert.alertTimestamp;
    });

    if (isOldAlert) {
        unsentAlerts = unsentAlerts.map((currentAlert) => {
            if (currentAlert.alert.alertTimestamp === newUnsentAlert.alert.alertTimestamp) {
                currentAlert = newUnsentAlert;
            }

            return currentAlert;
        });
    } else {
        unsentAlerts.push(newUnsentAlert);
    }

    await chrome.storage.local.set({ unsentAlerts });
    return true;
}

export async function sendAlert(alert: Alert) {
    const config = await getConfig();
    const url_alert = `${config.phishcatch_server}/alert`;

    try {
        const response = await fetch(url_alert, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(alert),
        });

        if (response.status === 200) {
            return true;
        } else {
            return false;
        }
    } catch (error) {
        return false;
    }
}

export async function createServerAlert(message: AlertContent) {
    const config = await getConfig();

    if (!config.phishcatch_server) {
        return false;
    }

    if (await checkIfDup(message)) {
        return false;
    }

    const data: Alert = {
        alertUrl: message.url,
        allAssociatedUsernames: '',
        psk: '',
        referrer: message.referrer,
        alertTimestamp: message.timestamp,
        alertType: message.alertType,
        suspectedUsername: message.associatedUsername,
        suspectedHost: message.associatedHostname,
        clientId: await getId(),
    };

    const usernames = (await getUsernames()).map((username) => username.username);

    data.allAssociatedUsernames = JSON.stringify(usernames);
    data.psk = config.psk;

    const sentAlert = await sendAlert(data);
    if (!sentAlert) {
        void saveUnsentAlert({
            alert: data,
            tries: 1,
        });
    }

    return data;
}

const thirtySeconds = 30 * 1000;
const RECENT_ALERTS_KEY = 'recentAlerts';

// MV3 service workers are terminated after ~30s of inactivity, so the dedup
// cache cannot live in a module-level variable - it would be wiped on every
// restart. Persist it in chrome.storage.session (in-memory, MV3-native, never
// written to disk, cleared when the browser closes), falling back to
// chrome.storage.local where session storage is unavailable.
function getDedupStore(): chrome.storage.StorageArea {
    return chrome.storage.session || chrome.storage.local;
}

async function getRecentAlerts(): Promise<Record<string, number>> {
    const data = await getDedupStore().get(RECENT_ALERTS_KEY);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    return (data[RECENT_ALERTS_KEY] as Record<string, number>) || {};
}

async function setRecentAlerts(recentAlerts: Record<string, number>): Promise<void> {
    await getDedupStore().set({ [RECENT_ALERTS_KEY]: recentAlerts });
}

export async function checkIfDup(message: AlertContent): Promise<boolean> {
    const now = new Date().getTime();

    const dupCheckString = JSON.stringify({
        url: message.url,
        alertType: message.alertType,
        username: message.associatedUsername,
        hostname: message.associatedHostname,
    });

    const recentAlerts = await getRecentAlerts();

    // Prune entries that have aged out of the dedup window. This replaces the old
    // timer-based reset and keeps the persisted store bounded across restarts.
    for (const key of Object.keys(recentAlerts)) {
        if (now - recentAlerts[key] >= thirtySeconds) {
            delete recentAlerts[key];
        }
    }

    const lastSeen = recentAlerts[dupCheckString];
    if (lastSeen !== undefined && now - lastSeen < thirtySeconds) {
        return true;
    }

    recentAlerts[dupCheckString] = now;
    await setRecentAlerts(recentAlerts);
    return false;
}
