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

import * as ort from 'onnxruntime-web';

import { InferenceRequestContent, PageMessage } from './types';

// Offscreen document ONNX engine. MV3 service workers forbid the dynamic import()
// onnxruntime-web uses to load its wasm glue (the import() ban in
// ServiceWorkerGlobalScope, see https://github.com/w3c/ServiceWorker/issues/1356).
// This document is a real DOM context on the extension origin, so dynamic import
// and WASM work normally and the host page's CSP does not apply. The service
// worker spawns it on demand and RPCs feature payloads here (see lib/inferenceRPC.ts).

let session: ort.InferenceSession | undefined;
let initPromise: Promise<void> | undefined;
let inferenceDisabled = false;

async function doInit(): Promise<void> {
    ort.env.wasm.wasmPaths = chrome.runtime.getURL('ml/');
    ort.env.wasm.numThreads = 1;

    const modelResponse = await fetch(chrome.runtime.getURL('ml/model.onnx'));
    const modelBuffer = await modelResponse.arrayBuffer();
    session = await ort.InferenceSession.create(modelBuffer, { executionProviders: ['wasm'] });
}

function ensureSession(): Promise<void> {
    if (!initPromise) {
        initPromise = doInit().catch((err) => {
            inferenceDisabled = true;
            session = undefined;
            console.warn('[phishcatch] inference disabled:', err);
        });
    }
    return initPromise;
}

function isPositive(output: ort.InferenceSession.OnnxValueMapType): boolean {
    // skl2onnx (zipmap off) names the class output "label" (int64).
    const labelTensor = output.label ?? output[Object.keys(output)[0]];
    if (!labelTensor || !labelTensor.data || labelTensor.data.length === 0) {
        return false;
    }
    // int64 surfaces as BigInt in onnxruntime-web, so coerce via Number().
    return Number(labelTensor.data[0]) === 1;
}

async function classify(payload: InferenceRequestContent): Promise<boolean> {
    await ensureSession();
    if (inferenceDisabled || !session) {
        return false;
    }

    // String tensors require a completely flat 1D array of primitive strings
    // whose length equals the product of the dims.
    const feeds: Record<string, ort.Tensor> = {
        booleans: new ort.Tensor('float32', Float32Array.from(payload.booleans), [1, payload.booleans.length]),
        categorical: new ort.Tensor('string', payload.categorical.map(String), [1, payload.categorical.length]),
        combined_text: new ort.Tensor('string', [payload.combined_text], [1, 1]),
    };

    try {
        const output = await session.run(feeds);
        return isPositive(output);
    } catch (err) {
        console.warn('[phishcatch] inference run failed:', err);
        return false;
    }
}

// Registered synchronously at module load so the listener is ready by the time
// chrome.offscreen.createDocument() resolves in the service worker.
chrome.runtime.onMessage.addListener((message: PageMessage, _sender, sendResponse) => {
    if (message && message.msgtype === 'offscreenInference' && message.target === 'offscreen') {
        classify(message.content as InferenceRequestContent)
            .then(sendResponse)
            .catch(() => sendResponse(false));
        return true;
    }
    return false;
});
