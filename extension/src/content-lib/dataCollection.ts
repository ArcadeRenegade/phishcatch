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

import { CollectFieldDataContent, RawFieldData } from '../types';
import { debounce } from './debounce';

// Raw data-collection scanner. Extracts structural/label features of interactive
// text elements into a flat RawFieldData record for offline LLM labeling. It is
// strictly data-minimized: it never reads the element `value` or the element's
// own typed `textContent` (those are user payloads). Gated by a storage flag.

const DATA_COLLECTION_FLAG_KEY = 'dataCollectionEnabled';

const COLLECTION_SELECTOR = [
    'input',
    'textarea',
    '*[role="textbox"]',
    '*[contenteditable="true"]',
    '*[role="searchbox"]',
    '*[role="combobox"]',
].join(', ');

// Strip these from any cloned element before reading text so that user-typed
// payloads (and noisy nodes) never leak into label/ancestor text.
const TEXT_STRIP_SELECTOR = 'select, svg, canvas, style, script, noscript, input, textarea, [contenteditable="true"]';

// input types whose own text is the semantic button label (the only case where
// element-own text is read). <button> is intentionally not in the selector.
const BUTTON_LIKE_TYPES = new Set(['button', 'submit', 'reset']);

const FUZZY_MAX_LEVELS = 4;

function attr(el: Element, name: string): string {
    return el.getAttribute(name) ?? '';
}

function normalize(text: string | null): string {
    return (text ?? '').replace(/\s+/g, ' ').trim();
}

// Clone + strip user-input/noise nodes, then return normalized textContent.
function getElementText(element: HTMLElement): string {
    const clone = element.cloneNode(true);
    if (!(clone instanceof HTMLElement)) {
        return normalize(clone.textContent);
    }

    clone.querySelectorAll(TEXT_STRIP_SELECTOR).forEach((node) => node.remove());

    return normalize(clone.textContent);
}

function isFormInput(el: HTMLElement): el is HTMLInputElement | HTMLTextAreaElement {
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

function isButtonLike(el: HTMLElement): boolean {
    return el instanceof HTMLInputElement && BUTTON_LIKE_TYPES.has(el.type);
}

function isHidden(el: HTMLElement): boolean {
    if (el.hidden) {
        return true;
    }
    return el instanceof HTMLInputElement && el.type === 'hidden';
}

function getLabelElements(el: HTMLElement): HTMLLabelElement[] {
    if (isFormInput(el) && el.labels?.length) {
        return Array.from(el.labels);
    }

    const previous = el.previousElementSibling;
    if (previous instanceof HTMLLabelElement) {
        return [previous];
    }

    const next = el.nextElementSibling;
    if (next instanceof HTMLLabelElement) {
        return [next];
    }

    return [];
}

function getOfficialLabelText(el: HTMLElement): string {
    return getLabelElements(el)
        .map((label) => getElementText(label))
        .filter(Boolean)
        .join(' | ');
}

// Walk up to a few ancestors and read nearby text, stopping at boundaries that
// indicate a different region (form, heading, iframe, or another input).
function getFuzzyParentText(el: HTMLElement): string {
    let level = 0;
    let current: HTMLElement = el;

    while (level < FUZZY_MAX_LEVELS && current.parentElement) {
        level++;
        const parent = current.parentElement;

        if (parent instanceof HTMLFormElement) {
            break;
        }

        if (parent.querySelector('h1, h2, h3, h4')) {
            break;
        }

        if (parent.querySelector('iframe')) {
            break;
        }

        const inputs = Array.from(parent.querySelectorAll('input, select, textarea'));
        const hasOtherInput = inputs.some((other) => {
            return other !== el && !(other as HTMLElement & { hidden?: boolean; }).hidden && (other as HTMLInputElement).type !== 'hidden';
        });
        if (hasOtherInput) {
            break;
        }

        current = parent;
    }

    return getElementText(current);
}

// Resolve a space-separated id reference attribute into the concatenated text of
// the referenced elements.
function resolveAriaRelation(el: HTMLElement, attribute: string): { ids: string; text: string; } {
    const ids = attr(el, attribute);
    if (!ids) {
        return { ids: '', text: '' };
    }

    const text = ids
        .split(' ')
        .map((value) => value.trim())
        .filter(Boolean)
        .map((id) => normalize(document.getElementById(id)?.textContent ?? ''))
        .filter(Boolean)
        .join(' | ');

    return { ids, text };
}

function getDatasetAttributes(el: HTMLElement): string {
    return Object.entries(el.dataset)
        .map(([key, value]) => `${key}=${value ?? ''}`)
        .join(' | ');
}

export function collectFieldData(el: HTMLElement): RawFieldData {
    const formInput = isFormInput(el);
    const ariaLabel = attr(el, 'aria-label');

    const officialLabelText = getOfficialLabelText(el);
    let fuzzyParentText = '';
    if (!officialLabelText && !ariaLabel && !isHidden(el)) {
        fuzzyParentText = getFuzzyParentText(el);
    }

    const labelledBy = resolveAriaRelation(el, 'aria-labelledby');
    const describedBy = resolveAriaRelation(el, 'aria-describedby');
    const controls = resolveAriaRelation(el, 'aria-controls');
    const errorMessage = resolveAriaRelation(el, 'aria-errormessage');

    return {
        // label placeholder - populated during offline/LLM labeling
        is_ai_prompt: null,

        collected_url: location.href,
        collected_at: Date.now(),

        tag_name: el.tagName.toLowerCase(),
        type: formInput ? el.type : attr(el, 'type'),
        role: attr(el, 'role'),
        read_only: formInput ? el.readOnly : false,
        disabled: formInput ? el.disabled : el.hasAttribute('disabled'),
        required: formInput ? el.required : attr(el, 'aria-required') === 'true',
        is_content_editable: el.isContentEditable,
        aria_expanded: attr(el, 'aria-expanded'),
        aria_haspopup: attr(el, 'aria-haspopup'),

        id: el.id,
        name: attr(el, 'name'),
        class_name: el.className,
        placeholder: attr(el, 'placeholder'),
        data_placeholder: attr(el, 'data-placeholder'),
        data_test_id: attr(el, 'data-test-id'),
        data_testid: attr(el, 'data-testid'),
        autocomplete: attr(el, 'autocomplete'),
        aria_label: ariaLabel,
        aria_placeholder: attr(el, 'aria-placeholder'),
        aria_roledescription: attr(el, 'aria-roledescription'),
        title: attr(el, 'title'),

        aria_labelledby: labelledBy.ids,
        aria_describedby: describedBy.ids,
        aria_controls: controls.ids,
        aria_errormessage: errorMessage.ids,

        aria_labelledby_text: labelledBy.text,
        aria_describedby_text: describedBy.text,
        aria_controls_text: controls.text,
        aria_errormessage_text: errorMessage.text,

        official_label_text: officialLabelText,
        fuzzy_parent_text: fuzzyParentText,
        // element-own text is read ONLY for button-like inputs (never for user-input fields)
        button_text: isButtonLike(el) ? getElementText(el) : '',
        form_control_name: attr(el, 'formcontrolname'),
        dataset_attributes: getDatasetAttributes(el),
    };
}

const seenElements = new WeakSet<Element>();
let collectionEnabled = false;
let observer: MutationObserver | undefined;

function sendFields(fields: RawFieldData[]): void {
    if (!fields.length) {
        return;
    }

    const content: CollectFieldDataContent = { fields };
    // Fire-and-forget; the service worker may be asleep or have no response.
    void chrome.runtime.sendMessage({ msgtype: 'collectFieldData', content }).catch(() => undefined);
}

function scanAndSend(): void {
    if (!collectionEnabled) {
        return;
    }

    const elements = Array.from(document.querySelectorAll<HTMLElement>(COLLECTION_SELECTOR));
    const fields: RawFieldData[] = [];

    for (const el of elements) {
        if (seenElements.has(el)) {
            continue;
        }
        seenElements.add(el);
        fields.push(collectFieldData(el));
    }

    sendFields(fields);
}

const debouncedScan = debounce(scanAndSend, 500) as () => void;

function startObserver(): void {
    if (observer || !document.body) {
        return;
    }

    observer = new MutationObserver(() => debouncedScan());
    observer.observe(document.body, { subtree: true, childList: true });
}

function stopObserver(): void {
    if (observer) {
        observer.disconnect();
        observer = undefined;
    }
}

function setEnabled(enabled: boolean): void {
    collectionEnabled = enabled;
    if (enabled) {
        startObserver();
        scanAndSend();
    } else {
        stopObserver();
    }
}

export function initDataCollection(): void {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && changes[DATA_COLLECTION_FLAG_KEY]) {
            setEnabled(Boolean(changes[DATA_COLLECTION_FLAG_KEY].newValue));
        }
    });

    void chrome.storage.local
        .get(DATA_COLLECTION_FLAG_KEY)
        .then((data) => setEnabled(Boolean((data as Record<string, unknown>)[DATA_COLLECTION_FLAG_KEY])))
        .catch(() => undefined);
}
