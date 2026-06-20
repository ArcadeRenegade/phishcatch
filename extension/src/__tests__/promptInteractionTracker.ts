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

import { initPromptSubmissionTracking, trackPrompt } from '../content-lib/promptInteractionTracker';

// Capture-phase document listeners are installed once for the whole jsdom
// document; module state (trackedPrompts/lastActivePrompt) persists across tests,
// so every test uses fresh elements and sets up its own focus.
let sendSpy: jest.SpyInstance;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface SentMessage {
    msgtype: string;
    content: Record<string, unknown>;
}

function aiPromptCalls(): SentMessage[] {
    return sendSpy.mock.calls
        .map((call): SentMessage => call[0])
        .filter((message) => message?.msgtype === 'aiPromptSubmission');
}

function makeContentEditable(): HTMLElement {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    div.setAttribute('tabindex', '0');
    // jsdom does not implement innerText; mirror textContent so the tracker's
    // MutationObserver callback reads the same value a real browser would.
    Object.defineProperty(div, 'innerText', {
        configurable: true,
        get(this: HTMLElement) {
            return this.textContent ?? '';
        },
    });
    // isContentEditable is derived from contenteditable in real DOM but is not
    // wired up in jsdom; force it true for the tracker's branch.
    Object.defineProperty(div, 'isContentEditable', { configurable: true, get: () => true });
    document.body.appendChild(div);
    return div;
}

function pressEnter(el: HTMLElement, shiftKey = false): void {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey, bubbles: true }));
}

beforeAll(() => {
    initPromptSubmissionTracking();
});

beforeEach(() => {
    sendSpy = jest.spyOn(chrome.runtime, 'sendMessage').mockResolvedValue(undefined as never);
});

afterEach(() => {
    document.body.innerHTML = '';
    sendSpy.mockRestore();
});

describe('promptInteractionTracker - Enter submission', () => {
    it('tracks input and dispatches telemetry on Enter (textarea)', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        trackPrompt(textarea);

        textarea.value = 'summarize this document';
        textarea.dispatchEvent(new Event('input'));
        textarea.focus();

        pressEnter(textarea);
        await flush();

        expect(aiPromptCalls()).toHaveLength(1);
        expect(aiPromptCalls()[0].msgtype).toBe('aiPromptSubmission');
    });

    it('does not dispatch on Shift+Enter (newline)', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        trackPrompt(textarea);

        textarea.value = 'line one';
        textarea.dispatchEvent(new Event('input'));
        textarea.focus();

        pressEnter(textarea, true);
        await flush();

        expect(aiPromptCalls()).toHaveLength(0);
    });

    it('does not dispatch on Enter pressed in an unrelated input', async () => {
        const prompt = document.createElement('textarea');
        const unrelated = document.createElement('input');
        document.body.appendChild(prompt);
        document.body.appendChild(unrelated);
        trackPrompt(prompt);

        // Prompt has text and was focused, then focus moves to an unrelated input.
        prompt.value = 'leftover prompt text';
        prompt.dispatchEvent(new Event('input'));
        prompt.focus();
        unrelated.focus();

        pressEnter(unrelated);
        await flush();

        expect(aiPromptCalls()).toHaveLength(0);
    });

    it('does not dispatch on Enter when prompt is empty', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        trackPrompt(textarea);
        textarea.focus();

        pressEnter(textarea);
        await flush();

        expect(aiPromptCalls()).toHaveLength(0);
    });

    it('dispatches on Enter for a contenteditable prompt after mutation', async () => {
        const div = makeContentEditable();
        trackPrompt(div);

        // Mutate AFTER tracking so the MutationObserver captures the typed text.
        div.textContent = 'write me a poem';
        // Let the MutationObserver flush so promptText is populated.
        await flush();
        div.focus();

        pressEnter(div);
        await flush();

        expect(aiPromptCalls()).toHaveLength(1);
    });
});

describe('promptInteractionTracker - button submission', () => {
    it('dispatches on a related button click when the prompt has text', async () => {
        const form = document.createElement('form');
        const textarea = document.createElement('textarea');
        const button = document.createElement('button');
        form.appendChild(textarea);
        form.appendChild(button);
        document.body.appendChild(form);
        trackPrompt(textarea);

        textarea.value = 'translate to french';
        textarea.dispatchEvent(new Event('input'));
        textarea.focus();

        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flush();

        expect(aiPromptCalls()).toHaveLength(1);
    });

    it('does not dispatch on a button click when the active prompt is empty', async () => {
        const form = document.createElement('form');
        const textarea = document.createElement('textarea');
        const button = document.createElement('button');
        form.appendChild(textarea);
        form.appendChild(button);
        document.body.appendChild(form);
        trackPrompt(textarea);
        textarea.focus();

        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flush();

        expect(aiPromptCalls()).toHaveLength(0);
    });

    it('does not dispatch when the clicked element is not a button', async () => {
        const textarea = document.createElement('textarea');
        const div = document.createElement('div');
        document.body.appendChild(textarea);
        document.body.appendChild(div);
        trackPrompt(textarea);

        textarea.value = 'some prompt';
        textarea.dispatchEvent(new Event('input'));
        textarea.focus();

        div.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flush();

        expect(aiPromptCalls()).toHaveLength(0);
    });
});

describe('promptInteractionTracker - state lifecycle and payload', () => {
    it('clears state after submission so a second Enter does not re-dispatch', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        trackPrompt(textarea);

        textarea.value = 'first message';
        textarea.dispatchEvent(new Event('input'));
        textarea.focus();

        pressEnter(textarea);
        await flush();
        expect(aiPromptCalls()).toHaveLength(1);

        // No new typing; pressing Enter again must not emit a duplicate.
        pressEnter(textarea);
        await flush();
        expect(aiPromptCalls()).toHaveLength(1);
    });

    it('payload contains only url/referrer/timestamp and no raw text', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        trackPrompt(textarea);

        const secret = 'super secret prompt body';
        textarea.value = secret;
        textarea.dispatchEvent(new Event('input'));
        textarea.focus();

        pressEnter(textarea);
        await flush();

        const message = aiPromptCalls()[0];
        expect(Object.keys(message.content).sort((a, b) => a.localeCompare(b))).toEqual(['referrer', 'timestamp', 'url']);
        expect(JSON.stringify(message)).not.toContain(secret);
    });
});
