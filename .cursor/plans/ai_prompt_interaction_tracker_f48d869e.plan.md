---
name: AI Prompt Interaction Tracker
overview: Add a content-script interaction tracker and capture-phase submission interceptor for elements classified as AI prompts, dispatching a metadata-only server alert (new AlertType) that mirrors the existing password telemetry pipeline. Raw prompt text stays local and is used only to gate/confirm a submission.
todos:
    - id: types
      content: "types.ts: add AlertTypes.AIPROMPT, 'aiPromptSubmission' msgtype, AiPromptSubmissionContent interface"
      status: completed
    - id: tracker
      content: 'Create content-lib/promptInteractionTracker.ts: WeakMap/WeakSet state, input+MutationObserver capture, capture-phase keydown/click submission detection, dispatch+clear'
      status: completed
    - id: wire-detection
      content: 'fieldDetection.ts: call trackPrompt(element) when isPrompt === true'
      status: completed
    - id: init-content
      content: 'content.ts: call initPromptSubmissionTracking() in ready() block'
      status: completed
    - id: background
      content: "background.ts: handle 'aiPromptSubmission' -> createServerAlert with AlertTypes.AIPROMPT"
      status: completed
    - id: tests
      content: Add __tests__/promptInteractionTracker.ts covering submission guardrails and state clearing
      status: completed
isProject: false
---

# AI Prompt Interaction Tracker and Submission Telemetry

## Design decisions (confirmed)

- Sink: existing server-alert pipeline (`createServerAlert` -> `sendAlert`), adding a new `AlertTypes.AIPROMPT`.
- Payload: mirror password behavior. The raw typed text is NEVER transmitted; it is held locally only to (a) require non-empty text before counting a submission and (b) be cleared after dispatch. The alert carries the same metadata the existing `Alert` already sends (url, referrer, timestamp, clientId, associated usernames, psk).
- The extension runs in all frames; each frame gets its own tracker instance and its own document-level capture listeners. This matches the existing per-frame `content.ts` model.
- Debug/demo logging: every meaningful event is `console.log`'d with a `[phishcatch]` prefix in BOTH threads — content script (tracking attached, text updated, Enter/click submission detected, telemetry dispatched, state cleared) and background (message received, alert created/deduped/queued). Logs include the element and metadata but NEVER the raw typed text (privacy parity).

## 1. Types and new alert type — `extension/src/types.ts`

- Add `AIPROMPT = 'aiprompt'` to the `AlertTypes` enum (used for dedup keying and server categorization).
- Extend the `PageMessage` union: add `'aiPromptSubmission'` to `msgtype`, and add `AiPromptSubmissionContent` to the `content` union.
- Add interface:

```ts
export interface AiPromptSubmissionContent {
    url: string;
    referrer: string;
    timestamp: number;
}
```

## 2. New module — `extension/src/content-lib/promptInteractionTracker.ts`

State (module-level, per frame):

```ts
const trackedPrompts = new WeakSet<HTMLElement>(); // membership test for capture handlers
const promptText = new WeakMap<HTMLElement, string>(); // latest typed value per prompt
const observers = new WeakMap<HTMLElement, MutationObserver>();
let lastActivePrompt: HTMLElement | undefined; // most-recently-focused tracked prompt
```

`trackPrompt(element: HTMLElement): void` (called when classification returns true; idempotent via `trackedPrompts`):

- Return early if already in `trackedPrompts`; otherwise add it. Log `console.log('[phishcatch] tracking AI prompt', element)`.
- textarea / input (`instanceof HTMLTextAreaElement || HTMLInputElement`): attach `element.addEventListener('input', () => { promptText.set(element, element.value); console.log('[phishcatch] prompt text updated, length', element.value.length); })`.
- contenteditable (`element.isContentEditable`): create a `MutationObserver` with `{ characterData: true, childList: true, subtree: true }` whose callback runs `promptText.set(element, (element.innerText ?? '').trim())` and logs the new length; store it in `observers` and `observe(element, ...)`.
- Logs report only the text LENGTH, never the text itself.

`initPromptSubmissionTracking(): void` (called once from `content.ts`):

- `document.addEventListener('focusin', onFocusIn, true)` — if `resolvePrompt(e.target)` is tracked, set `lastActivePrompt`.
- `document.addEventListener('keydown', onKeyDown, { capture: true })`.
- `document.addEventListener('click', onClick, { capture: true })`.

Helpers:

- `resolvePrompt(node): HTMLElement | undefined` — if `node` (or nearest ancestor via `closest`) is in `trackedPrompts`, return it (handles Enter fired on a child of a contenteditable).
- `hasText(prompt): boolean` — `(promptText.get(prompt) ?? '').length > 0`.
- `isSubmissionButton(node): boolean` — `node` is a `<button>`, `<input type=submit|button>`, or `[role="button"]` (use `closest`).
- `isStructurallyRelated(button, prompt): boolean` — true if same form (`button.closest('form') === prompt.closest('form')` and not null), OR they share a common ancestor within ~4 levels, OR `prompt === lastActivePrompt` (the "most recently focused" criterion from the requirement).

Submission handlers:

- `onKeyDown(e)`: ignore if `e.isComposing || e.keyCode === 229` (IME). If `e.key === 'Enter' && !e.shiftKey`:
    - Resolve strictly from the event target: `const p = resolvePrompt(e.target);`
    - Bulletproof guard against a global/stray Enter triggering a stale prompt: require that the resolved prompt is the CURRENTLY FOCUSED element, i.e. `const active = p && (p === document.activeElement || p.contains(document.activeElement));`
    - Only then: `if (p && active && hasText(p)) { console.log('[phishcatch] submission detected via Enter', p); confirmSubmission(p); }`
    - Rationale: Enter MUST originate from the prompt itself. `lastActivePrompt` is intentionally NOT consulted here — if the user focused the prompt (leaving text), clicked into a native search bar / unrelated input, and pressed Enter, `e.target` resolves to that unrelated element (not the tracked prompt) and the focus check fails, so no false submission fires. `lastActivePrompt` is used ONLY for button-click association (below), where the click target is legitimately outside the prompt.
- `onClick(e)`: `if (!isSubmissionButton(e.target)) return; const p = lastActivePrompt; if (p && hasText(p) && isStructurallyRelated(e.target, p)) { console.log('[phishcatch] submission detected via button click', e.target, p); confirmSubmission(p); }`
- `confirmSubmission(prompt)`: call `dispatchTelemetry()` then `promptText.delete(prompt)` and log `console.log('[phishcatch] prompt state cleared after submission')`. Do NOT remove from `trackedPrompts` (element persists; next keystroke repopulates).

`dispatchTelemetry()` mirrors `checkPassword` in `content.ts` (uses `getSanitizedUrl`):

```ts
const content: AiPromptSubmissionContent = {
    url: await getSanitizedUrl(location.href),
    referrer: await getSanitizedUrl(document.referrer),
    timestamp: Date.now()
};
console.log('[phishcatch] dispatching AI prompt telemetry', content);
void chrome.runtime
    .sendMessage({ msgtype: 'aiPromptSubmission', content })
    .catch(() => undefined);
```

Note: prompt text is intentionally excluded from the message (privacy parity with hashed passwords), so the logged `content` carries only url/referrer/timestamp.

## 3. Wire classification to the tracker — `extension/src/content-lib/fieldDetection.ts`

In `requestClassification`, the existing positive branch logs the detection:

```89:97:extension/src/content-lib/fieldDetection.ts
        const isPrompt = await chrome.runtime.sendMessage({ msgtype: 'runInference', content });
        if (isPrompt === true) {
            console.log('🚨 AI Prompt Detected:', element, raw);
        }
```

- Import `trackPrompt` and call `trackPrompt(element)` inside the `isPrompt === true` block. `fieldDetection` already dedups elements via its own `seenElements` `WeakSet`, so each element is classified (and thus tracked) at most once.

## 4. Initialize the tracker — `extension/src/content.ts`

In the `ready(() => { ... })` block, alongside `startFieldDetection()`:

```153:160:extension/src/content.ts
ready(() => {
    initDataCollection();
    startFieldDetection();
```

- Import and call `initPromptSubmissionTracking()` so the document-level capture listeners are installed once per frame, independent of domain type (AI prompts are not limited to enterprise/dangerous domains). `initPromptSubmissionTracking()` logs `console.log('[phishcatch] AI prompt submission tracking initialized')` once on install.

## 5. Background handler — `extension/src/background.ts`

Add a case to the `receiveMessage` switch (mirrors the `password`/`collectFieldData` cases):

```ts
case 'aiPromptSubmission': {
    const content = <AiPromptSubmissionContent>message.content;
    console.log('[phishcatch] aiPromptSubmission received', content);
    void createServerAlert({
        url: content.url,
        referrer: content.referrer,
        timestamp: content.timestamp,
        alertType: AlertTypes.AIPROMPT,
    }).then((result) => {
        console.log('[phishcatch] AI prompt alert result', result);
    });
    break;
}
```

- Import `AiPromptSubmissionContent` and (already imported) `AlertTypes`, `createServerAlert`.
- `createServerAlert` already: skips when no `phishcatch_server` configured (returns `false`), dedups by url+alertType+username+host within 30s (via `chrome.storage.session`, returns `false`), attaches `clientId`, associated usernames, and `psk`, and queues to `unsentAlerts` on failure — all reused unchanged. The `.then` log surfaces which of these happened (the returned `Alert` object, or `false` when skipped/deduped) so the demo shows the outcome in the service-worker console.

## 6. Tests — `extension/src/__tests__/promptInteractionTracker.ts` (new)

Using the existing jsdom setup, cover the guardrails:

- input/textarea `input` event updates state; Enter (no shift) on a tracked element with text dispatches one `chrome.runtime.sendMessage` with `msgtype: 'aiPromptSubmission'`; Shift+Enter does not.
- contenteditable mutations update state and Enter dispatches.
- Button click dispatches only when a related prompt has text; unrelated button or empty text does not.
- State is cleared after dispatch (a second immediate Enter with no new typing does not re-dispatch).
- Assert no raw text is present in the dispatched message payload.

## Notes / behavior to be aware of

- 30s dedup in `createServerAlert` means rapid repeated submissions on the same URL collapse to one alert (consistent with existing password-alert behavior).
- No desktop notification is shown for prompt submissions (telemetry is silent), unlike password-reuse alerts; this can be added later if desired.
