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

import { InferenceRequestContent, RawFieldData } from '../types';
import { COLLECTION_SELECTOR, collectFieldData } from './dataCollection';
import { debounce } from './debounce';

// Content-side field-detection SCRAPER. It does NOT run any ML: the service
// worker owns onnxruntime-web (see lib/inferenceRPC.ts). This module only has
// DOM access, so its job is to find interactive elements, extract + format their
// features per feature_schema.json, and delegate classification to the worker
// over RPC. Keeping ORT out of the content script avoids per-iframe WASM bloat
// and host-page CSPs blocking inference.

interface FeatureSchema {
    target_key: string;
    boolean_keys: string[];
    categorical_keys: string[];
    text_keys: string[];
    combined_text_column: string;
}

// Cached so the schema is fetched once per content-script instance.
let schemaPromise: Promise<FeatureSchema | undefined> | undefined;

function loadSchema(): Promise<FeatureSchema | undefined> {
    if (!schemaPromise) {
        schemaPromise = fetch(chrome.runtime.getURL('ml/feature_schema.json'))
            .then((response) => response.json() as Promise<FeatureSchema>)
            .catch((err) => {
                console.warn('[phishcatch] could not load feature schema:', err);
                return undefined;
            });
    }
    return schemaPromise;
}

function getValue(raw: RawFieldData, key: string): unknown {
    return (raw as unknown as Record<string, unknown>)[key];
}

// Booleans -> number[] (1/0), mirroring the float32 cast in Python.
function buildBooleans(raw: RawFieldData, keys: string[]): number[] {
    return keys.map((key) => (getValue(raw, key) ? 1 : 0));
}

// Categoricals -> raw strings as-is; null/undefined/empty -> "". No trim/case
// changes: OneHotEncoder matches exact category strings (matches Python).
function buildCategoricals(raw: RawFieldData, keys: string[]): string[] {
    return keys.map((key) => {
        const value = getValue(raw, key);
        return value === null || value === undefined || value === '' ? '' : String(value);
    });
}

// combined_text -> trim, drop empties, single-space join (mirrors Python
// str(v).strip()). No lowercasing/regex/punctuation handling: the ONNX-embedded
// TF-IDF graph tokenizes (token_pattern=[a-zA-Z0-9]{2,}) and lowercases natively.
function buildCombinedText(raw: RawFieldData, keys: string[]): string {
    return keys
        .map((key) => getValue(raw, key))
        .filter((value) => value !== null && value !== undefined)
        .map((value) => String(value).trim())
        .filter((value) => value.length > 0)
        .join(' ');
}

// Extract one element's features and ask the service worker to classify it.
async function requestClassification(element: HTMLElement, activeSchema: FeatureSchema): Promise<void> {
    const raw = collectFieldData(element);

    const content: InferenceRequestContent = {
        booleans: buildBooleans(raw, activeSchema.boolean_keys),
        categorical: buildCategoricals(raw, activeSchema.categorical_keys),
        combined_text: buildCombinedText(raw, activeSchema.text_keys),
    };

    try {
        const isPrompt = await chrome.runtime.sendMessage({ msgtype: 'runInference', content });
        if (isPrompt === true) {
            console.log('🚨 AI Prompt Detected:', element, raw);
        }
    } catch (err) {
        // The service worker may be unavailable (e.g. during reload); ignore.
        void err;
    }
}

const seenElements = new WeakSet<Element>();

async function scanForFields(): Promise<void> {
    const activeSchema = await loadSchema();
    if (!activeSchema) {
        return;
    }

    const elements = Array.from(document.querySelectorAll<HTMLElement>(COLLECTION_SELECTOR));
    for (const element of elements) {
        // Dedupe BEFORE any RPC: mark synchronously so rapid SPA mutations never
        // enqueue the same element twice on the message bus.
        if (seenElements.has(element)) {
            continue;
        }
        seenElements.add(element);
        void requestClassification(element, activeSchema);
    }
}

const debouncedScanForFields = debounce(scanForFields, 500) as () => void;
let observer: MutationObserver | undefined;

// Entry point: scan now, then re-scan (debounced) as the DOM mutates.
export function startFieldDetection(): void {
    void scanForFields();

    if (!observer && document.body) {
        observer = new MutationObserver(() => debouncedScanForFields());
        observer.observe(document.body, { subtree: true, childList: true });
    }
}
