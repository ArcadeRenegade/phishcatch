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

import { RawFieldData } from '../types';
import { COLLECTION_SELECTOR, collectFieldData } from './dataCollection';
import { debounce } from './debounce';

// Real-time AI-prompt detection. Loads the ONNX model + feature schema exported
// by the Python pipeline, preprocesses each interactive element EXACTLY as
// pipeline/preprocessing.py does (to avoid training-serving skew), runs the
// model in onnxruntime-web, and console.logs detected prompts.

interface FeatureSchema {
    target_key: string;
    boolean_keys: string[];
    categorical_keys: string[];
    text_keys: string[];
    combined_text_column: string;
}

let session: ort.InferenceSession | undefined;
let schema: FeatureSchema | undefined;
let inferenceDisabled = false;
let initPromise: Promise<void> | undefined;

async function doInit(): Promise<void> {
    // Tell ORT where to fetch the wasm binary from (the extension bundle), and
    // run single-threaded so we never need SharedArrayBuffer / COOP+COEP, which
    // we cannot control on third-party host pages.
    ort.env.wasm.wasmPaths = chrome.runtime.getURL('ml/');
    ort.env.wasm.numThreads = 1;

    const schemaResponse = await fetch(chrome.runtime.getURL('ml/feature_schema.json'));
    schema = (await schemaResponse.json()) as FeatureSchema;

    const modelResponse = await fetch(chrome.runtime.getURL('ml/model.onnx'));
    const modelBuffer = await modelResponse.arrayBuffer();
    session = await ort.InferenceSession.create(modelBuffer, { executionProviders: ['wasm'] });
}

// Idempotent. On any failure (commonly a strict host-page CSP blocking the wasm
// fetch/compile) we disable inference gracefully rather than throwing into the page.
export function initInference(): Promise<void> {
    if (!initPromise) {
        initPromise = doInit().catch((err) => {
            inferenceDisabled = true;
            session = undefined;
            schema = undefined;
            console.warn('[phishcatch] inference disabled:', err);
        });
    }
    return initPromise;
}

function getValue(raw: RawFieldData, key: string): unknown {
    return (raw as unknown as Record<string, unknown>)[key];
}

// Booleans -> Float32Array (1.0/0.0), mirroring the float32 cast in Python.
function buildBooleans(raw: RawFieldData, keys: string[]): Float32Array {
    const values = new Float32Array(keys.length);
    keys.forEach((key, index) => {
        values[index] = getValue(raw, key) ? 1 : 0;
    });
    return values;
}

// Categoricals -> flat 1D array of primitive strings; null/undefined/empty -> "".
function buildCategoricals(raw: RawFieldData, keys: string[]): string[] {
    return keys.map((key) => {
        const value = getValue(raw, key);
        return value === null || value === undefined || value === '' ? '' : String(value);
    });
}

// combined_text -> strip, drop empties, single-space join (matches Python).
function buildCombinedText(raw: RawFieldData, keys: string[]): string {
    return keys
        .map((key) => getValue(raw, key))
        .filter((value) => value !== null && value !== undefined)
        .map((value) => String(value).trim())
        .filter((value) => value.length > 0)
        .join(' ');
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

async function classify(element: HTMLElement): Promise<void> {
    if (inferenceDisabled || !session || !schema) {
        return;
    }

    const raw = collectFieldData(element);

    // String tensors require a completely flat 1D array of primitive strings
    // whose length equals the product of the dims.
    const feeds: Record<string, ort.Tensor> = {
        booleans: new ort.Tensor('float32', buildBooleans(raw, schema.boolean_keys), [1, schema.boolean_keys.length]),
        categorical: new ort.Tensor('string', buildCategoricals(raw, schema.categorical_keys), [
            1,
            schema.categorical_keys.length,
        ]),
        combined_text: new ort.Tensor('string', [buildCombinedText(raw, schema.text_keys)], [1, 1]),
    };

    try {
        const output = await session.run(feeds);
        if (isPositive(output)) {
            console.log('🚨 AI Prompt Detected:', element, raw);
        }
    } catch (err) {
        console.warn('[phishcatch] inference run failed:', err);
    }
}

const seenElements = new WeakSet<Element>();

async function scan(): Promise<void> {
    await initInference();
    if (inferenceDisabled) {
        return;
    }

    const elements = Array.from(document.querySelectorAll<HTMLElement>(COLLECTION_SELECTOR));
    for (const element of elements) {
        if (seenElements.has(element)) {
            continue;
        }
        seenElements.add(element);
        await classify(element);
    }
}

const debouncedScan = debounce(scan, 500) as () => void;
let observer: MutationObserver | undefined;

export function runInferenceScan(): void {
    void scan();

    if (!observer && document.body) {
        observer = new MutationObserver(() => debouncedScan());
        observer.observe(document.body, { subtree: true, childList: true });
    }
}
