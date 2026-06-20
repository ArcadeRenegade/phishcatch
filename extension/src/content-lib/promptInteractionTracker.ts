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

import { getSanitizedUrl } from '../lib/getSanitizedUrl';
import { AiPromptSubmissionContent } from '../types';

// Content-side interaction tracker for elements classified as AI prompts.
// Mirrors the password telemetry pattern in content.ts: it watches the typed
// value locally (to gate a submission on non-empty text), detects submission via
// capture-phase document listeners (robust against SPA stopPropagation), and
// dispatches sanitized metadata to the service worker. The raw typed text is
// NEVER transmitted - it is held only to confirm a submission, then cleared.

// Quick membership test for the capture-phase handlers.
const trackedPrompts = new WeakSet<HTMLElement>();
// Latest typed value per prompt (kept only to require non-empty text on submit).
const promptText = new WeakMap<HTMLElement, string>();
// Most-recently-focused tracked prompt, used ONLY for button-click association.
let lastActivePrompt: HTMLElement | undefined;

// How many ancestors up to look for a shared container between a clicked button
// and the active prompt.
const RELATION_MAX_LEVELS = 4;

function isFormField(el: HTMLElement): el is HTMLInputElement | HTMLTextAreaElement {
    return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
}

// Attach text-tracking listeners to a classified prompt. Idempotent.
export function trackPrompt(element: HTMLElement): void {
    if (trackedPrompts.has(element)) {
        return;
    }
    trackedPrompts.add(element);
    console.log('[phishcatch] tracking AI prompt', element);

    if (isFormField(element)) {
        element.addEventListener('input', () => {
            promptText.set(element, element.value);
            console.log('[phishcatch] prompt text updated, length', element.value.length);
        });
        return;
    }

    if (element.isContentEditable) {
        // The observed node retains the observer for its lifetime, so no extra
        // reference is needed to keep callbacks firing.
        const observer = new MutationObserver(() => {
            const text = (element.innerText ?? '').trim();
            promptText.set(element, text);
            console.log('[phishcatch] prompt text updated, length', text.length);
        });
        observer.observe(element, { characterData: true, childList: true, subtree: true });
    }
}

// Resolve an event target to its tracked prompt: the target itself, or the
// nearest tracked ancestor (handles Enter fired on a child of a contenteditable).
function resolvePrompt(node: EventTarget | null): HTMLElement | undefined {
    let current = node instanceof HTMLElement ? node : null;
    while (current) {
        if (trackedPrompts.has(current)) {
            return current;
        }
        current = current.parentElement;
    }
    return undefined;
}

function hasText(prompt: HTMLElement): boolean {
    return (promptText.get(prompt) ?? '').length > 0;
}

function isSubmissionButton(node: EventTarget | null): boolean {
    if (!(node instanceof HTMLElement)) {
        return false;
    }
    return Boolean(node.closest('button, input[type="submit"], input[type="button"], [role="button"]'));
}

// A clicked button counts as the prompt's submit control when it shares the
// prompt's form, sits within a few ancestors of the prompt, or the prompt was the
// most recently focused element (the "most recently focused" criterion).
function isStructurallyRelated(button: HTMLElement, prompt: HTMLElement): boolean {
    if (prompt === lastActivePrompt) {
        return true;
    }

    const buttonForm = button.closest('form');
    const promptForm = prompt.closest('form');
    if (buttonForm && buttonForm === promptForm) {
        return true;
    }

    let ancestor: HTMLElement | null = prompt;
    for (let level = 0; level < RELATION_MAX_LEVELS && ancestor; level++) {
        if (ancestor.contains(button)) {
            return true;
        }
        ancestor = ancestor.parentElement;
    }

    return false;
}

function confirmSubmission(prompt: HTMLElement): void {
    void dispatchTelemetry();
    promptText.delete(prompt);
    console.log('[phishcatch] prompt state cleared after submission');
}

async function dispatchTelemetry(): Promise<void> {
    const content: AiPromptSubmissionContent = {
        url: await getSanitizedUrl(location.href),
        referrer: await getSanitizedUrl(document.referrer),
        timestamp: Date.now(),
    };
    console.log('[phishcatch] dispatching AI prompt telemetry', content);
    // Fire-and-forget; the service worker may be asleep or have no response.
    void chrome.runtime.sendMessage({ msgtype: 'aiPromptSubmission', content }).catch(() => undefined);
}

function onFocusIn(event: FocusEvent): void {
    const prompt = resolvePrompt(event.target);
    if (prompt) {
        lastActivePrompt = prompt;
    }
}

function onKeyDown(event: KeyboardEvent): void {
    // Ignore composition (IME) commits, which also fire Enter.
    if (event.isComposing || event.keyCode === 229) {
        return;
    }
    if (event.key !== 'Enter' || event.shiftKey) {
        return;
    }

    // Resolve STRICTLY from the event target (never lastActivePrompt): a global
    // Enter pressed in an unrelated input must not submit a backgrounded prompt.
    const prompt = resolvePrompt(event.target);
    // Bulletproof guard: the resolved prompt must be the currently focused element.
    const active = prompt && (prompt === document.activeElement || prompt.contains(document.activeElement));
    if (prompt && active && hasText(prompt)) {
        console.log('[phishcatch] submission detected via Enter', prompt);
        confirmSubmission(prompt);
    }
}

function onClick(event: MouseEvent): void {
    if (!isSubmissionButton(event.target)) {
        return;
    }
    const prompt = lastActivePrompt;
    if (prompt && hasText(prompt) && isStructurallyRelated(event.target as HTMLElement, prompt)) {
        console.log('[phishcatch] submission detected via button click', event.target, prompt);
        confirmSubmission(prompt);
    }
}

// Install document-level capture listeners once per frame. Capture phase is used
// so SPA handlers calling stopPropagation() cannot hide submissions from us.
export function initPromptSubmissionTracking(): void {
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('keydown', onKeyDown, { capture: true });
    document.addEventListener('click', onClick, { capture: true });
    console.log('[phishcatch] AI prompt submission tracking initialized');
}
