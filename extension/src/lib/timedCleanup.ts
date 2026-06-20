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
import { getSavedDomHashes } from './domhash';
import { getUnsentAlerts, sendAlert } from './sendAlert';
import { getPasswordHashes, getUsernames } from './userInfo';

const hourValue = 1000 * 60 * 60;
const dayValue = hourValue * 24;

export const passwordHashLimit = 20;
export const domHashLimit = 50;

export function dateDiffInDays(date1: number, date2: number) {
    const diffInMs = date2 - date1;
    const diffInDays = diffInMs / dayValue;
    return Math.abs(diffInDays);
}

function notEmpty<TValue>(value: TValue | null | undefined): value is TValue {
    return value !== null && value !== undefined;
}

async function cleanData(hashes: { dateAdded: number; }[], hashLimit: number) {
    const config = await getConfig();
    const currentDate = new Date().getTime();

    return hashes
        .map((hash) => {
            if (typeof hash.dateAdded !== 'number') {
                hash.dateAdded = new Date().getTime();
            }

            return hash;
        })
        .filter((hash) => {
            return dateDiffInDays(hash.dateAdded, currentDate) < config.data_expiry;
        })
        .sort((hash1, hash2) => {
            return hash2.dateAdded - hash1.dateAdded;
        })
        .slice(0, hashLimit);
}

export async function cleanupUsernamesAndPasswords() {
    const currentDate = new Date().getTime();
    const config = await getConfig();

    const usernames = (await getUsernames()).filter((username) => {
        return dateDiffInDays(username.dateAdded, currentDate) < config.data_expiry;
    });

    const passwordHashes = await cleanData(await getPasswordHashes(), passwordHashLimit);

    const datedDomHashes = await cleanData(await getSavedDomHashes(), domHashLimit);

    await chrome.storage.local.set({
        usernames,
        passwordHashes,
        datedDomHashes,
    });

    return true;
}

export async function tryToSendFailedAlerts() {
    const currentDate = new Date().getTime();

    let unsentAlerts = (await getUnsentAlerts()).filter((unsentAlert) => {
        const dateDiff = dateDiffInDays(unsentAlert.alert.alertTimestamp, currentDate);

        return dateDiff < 30;
    });

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    unsentAlerts = (
        await Promise.all(
            unsentAlerts.map(async (unsentAlert) => {
                const sentAlert = await sendAlert(unsentAlert.alert);
                if (sentAlert) {
                    return null;
                } else {
                    unsentAlert.tries++;
                    return unsentAlert;
                }
            }),
        )
    ).filter(notEmpty);

    await chrome.storage.local.set({ unsentAlerts });

    return unsentAlerts;
}

// MV3 service workers are short-lived, so the recurring cleanup is driven by a
// chrome.alarms alarm (registered below) rather than setInterval, which would
// not survive worker termination.
export const CLEANUP_ALARM_NAME = 'phishcatch-cleanup';
const CLEANUP_INTERVAL_MINUTES = 60;
const CLEANUP_INTERVAL_MS = CLEANUP_INTERVAL_MINUTES * 60 * 1000;
const LAST_CLEANUP_KEY = 'lastCleanupAt';

// Runs the actual cleanup, gated by a persisted timestamp. The MV3 service
// worker re-evaluates this module on every wake (each message/notification/tab
// event after idle), so without a guard cleanup would run far more often than
// the MV2 once-per-load behaviour. The gate ensures cleanup runs at most once
// per interval, whether triggered by a wake or by the alarm.
export async function runScheduledCleanup() {
    const { lastCleanupAt } = (await chrome.storage.local.get(LAST_CLEANUP_KEY)) as { lastCleanupAt?: number; };
    const now = Date.now();
    if (lastCleanupAt && now - lastCleanupAt < CLEANUP_INTERVAL_MS) {
        return false;
    }

    // Claim the slot before doing the work so concurrent wakes don't double-run.
    await chrome.storage.local.set({ [LAST_CLEANUP_KEY]: now });
    await tryToSendFailedAlerts();
    await cleanupUsernamesAndPasswords();
    return true;
}

// Ensure the recurring alarm exists without resetting its schedule on every
// wake - calling alarms.create unconditionally would push the next fire out by
// a full interval each time the worker restarts.
async function ensureCleanupAlarm() {
    const existing = await chrome.alarms.get(CLEANUP_ALARM_NAME);
    if (!existing) {
        chrome.alarms.create(CLEANUP_ALARM_NAME, { periodInMinutes: CLEANUP_INTERVAL_MINUTES });
    }
}

export function timedCleanup() {
    void runScheduledCleanup();
    void ensureCleanupAlarm();
}
