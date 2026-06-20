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

import { InferenceRequestContent } from '../types';

// Service-worker-side inference proxy. The MV3 service worker cannot run
// onnxruntime-web itself: ORT loads its wasm glue via dynamic import(), which is
// banned in ServiceWorkerGlobalScope (https://github.com/w3c/ServiceWorker/issues/1356).
// Instead the worker lazily spawns an offscreen document (offscreen.ts) - a real
// DOM context where dynamic import()/WASM are allowed - and forwards feature
// payloads to it over runtime messaging.

const OFFSCREEN_URL = 'offscreen.html';

// Single in-flight creation promise so concurrent requests don't race to create
// more than one document (Chrome allows only one offscreen document per extension).
let creating: Promise<void> | undefined;

async function ensureOffscreen(): Promise<void> {
    if (await chrome.offscreen.hasDocument()) {
        return;
    }
    if (!creating) {
        creating = chrome.offscreen
            .createDocument({
                url: OFFSCREEN_URL,
                // No reason maps cleanly to "run WASM"; WORKERS is the closest and
                // matches ORT's threaded/worker-style execution model.
                reasons: [chrome.offscreen.Reason.WORKERS],
                justification: 'Run on-device ONNX (WebAssembly) classification of page text fields, which the service worker cannot host.',
            })
            .finally(() => {
                creating = undefined;
            });
    }
    await creating;
}

export async function runInference(payload: InferenceRequestContent): Promise<boolean> {
    try {
        await ensureOffscreen();
        const result = await chrome.runtime.sendMessage({
            msgtype: 'offscreenInference',
            target: 'offscreen',
            content: payload,
        });
        return result === true;
    } catch (err) {
        // Offscreen unavailable (WASM blocked, document closed mid-flight, etc.).
        console.warn('[phishcatch] inference unavailable:', err);
        return false;
    }
}
