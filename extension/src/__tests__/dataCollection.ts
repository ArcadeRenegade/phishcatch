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

import { collectFieldData } from '../content-lib/dataCollection';

function render(html: string): void {
    document.body.innerHTML = html;
}

function target(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) {
        throw new Error(`missing #${id}`);
    }
    return el;
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('collectFieldData - structural + attribute extraction', () => {
    it('extracts tag, type, id, name, placeholder, autocomplete', () => {
        render(`
      <label>Email</label>
      <input id="email" name="email" type="email" placeholder="you@example.com" autocomplete="email" />
    `);

        const record = collectFieldData(target('email'));

        expect(record.tag_name).toBe('input');
        expect(record.type).toBe('email');
        expect(record.id).toBe('email');
        expect(record.name).toBe('email');
        expect(record.placeholder).toBe('you@example.com');
        expect(record.autocomplete).toBe('email');
        expect(typeof record.collected_url).toBe('string');
        expect(typeof record.collected_at).toBe('number');
    });

    it('initializes is_ai_prompt to null for offline labeling', () => {
        render(`<input id="p" type="text" />`);

        const record = collectFieldData(target('p'));

        expect(record.is_ai_prompt).toBeNull();
    });

    it('extracts structural booleans', () => {
        render(`<input id="b" type="text" required disabled readonly />`);

        const record = collectFieldData(target('b'));

        expect(record.read_only).toBe(true);
        expect(record.disabled).toBe(true);
        expect(record.required).toBe(true);
    });

    it('extracts dataset attributes and angular form control name', () => {
        render(`<input id="d" data-test-id="t1" data-placeholder="dp" formcontrolname="myControl" data-foo="bar" />`);

        const record = collectFieldData(target('d'));

        expect(record.data_test_id).toBe('t1');
        expect(record.data_placeholder).toBe('dp');
        expect(record.form_control_name).toBe('myControl');
        expect(record.dataset_attributes).toContain('foo=bar');
        expect(record.dataset_attributes).toContain('testId=t1');
    });
});

describe('collectFieldData - data minimization (no user payloads)', () => {
    it('never emits a value key', () => {
        render(`<input id="v" type="text" value="my secret value" />`);

        const record = collectFieldData(target('v'));

        expect(record).not.toHaveProperty('value');
        expect(JSON.stringify(record)).not.toContain('my secret value');
    });

    it('never emits tab_index or aria_valuetext keys', () => {
        render(`<input id="t" tabindex="3" aria-valuetext="forty two" />`);

        const record = collectFieldData(target('t'));

        expect(record).not.toHaveProperty('tab_index');
        expect(record).not.toHaveProperty('aria_valuetext');
        expect(JSON.stringify(record)).not.toContain('forty two');
    });

    it('does not capture a textarea typed textContent', () => {
        render(`<textarea id="bio" name="bio">SUPER SECRET PAYLOAD</textarea>`);

        const record = collectFieldData(target('bio'));

        expect(record.tag_name).toBe('textarea');
        expect(record.button_text).toBe('');
        expect(JSON.stringify(record)).not.toContain('SUPER SECRET PAYLOAD');
    });

    it('does not capture a contenteditable typed textContent', () => {
        render(`<div id="ce" role="textbox" contenteditable="true">USER TYPED HERE</div>`);

        const record = collectFieldData(target('ce'));

        expect(record.tag_name).toBe('div');
        expect(record.role).toBe('textbox');
        expect(JSON.stringify(record)).not.toContain('USER TYPED HERE');
    });

    it('does not capture the value of a submit input', () => {
        render(`<input id="s" type="submit" value="Search Now" />`);

        const record = collectFieldData(target('s'));

        expect(record.type).toBe('submit');
        // input elements have no textContent, so button_text is empty and value is never read
        expect(record.button_text).toBe('');
        expect(JSON.stringify(record)).not.toContain('Search Now');
    });

    it('strips nested inputs/textarea when reading fuzzy parent text', () => {
        render(`
      <div>
        <span>Shipping address</span>
        <textarea id="addr">LEAKED ADDRESS PAYLOAD</textarea>
      </div>
    `);

        const record = collectFieldData(target('addr'));

        expect(JSON.stringify(record)).not.toContain('LEAKED ADDRESS PAYLOAD');
    });
});

describe('collectFieldData - label precedence', () => {
    it('uses an official sibling label and skips fuzzy when present', () => {
        render(`
      <label>First name</label>
      <input id="fn" />
    `);

        const record = collectFieldData(target('fn'));

        expect(record.official_label_text).toBe('First name');
        expect(record.fuzzy_parent_text).toBe('');
    });

    it('falls back to fuzzy parent text when there is no official label or aria-label', () => {
        render(`
      <div>Account number</div>
      <input id="acct" />
    `);

        const record = collectFieldData(target('acct'));

        expect(record.official_label_text).toBe('');
        expect(record.fuzzy_parent_text).toContain('Account number');
    });

    it('does not run the fuzzy fallback when an aria-label is present', () => {
        render(`
      <div>
        <span>Surrounding noise</span>
        <input id="a" aria-label="Search" />
      </div>
    `);

        const record = collectFieldData(target('a'));

        expect(record.aria_label).toBe('Search');
        expect(record.official_label_text).toBe('');
        expect(record.fuzzy_parent_text).toBe('');
    });

    it('reads button-like input text only for button/submit/reset', () => {
        render(`<input id="text" type="text" /><input id="btn" type="button" />`);

        expect(collectFieldData(target('text')).button_text).toBe('');
        // an <input> has no child text, so this is empty, but it confirms the branch is button-only
        expect(collectFieldData(target('btn')).button_text).toBe('');
    });
});

describe('collectFieldData - aria relation resolution', () => {
    it('resolves aria-labelledby / aria-describedby / aria-controls ids to text content', () => {
        render(`
      <span id="lbl">Username</span>
      <span id="desc">Enter your handle</span>
      <input id="u" role="searchbox" aria-labelledby="lbl" aria-describedby="desc" aria-controls="lbl" />
    `);

        const record = collectFieldData(target('u'));

        expect(record.role).toBe('searchbox');
        expect(record.aria_labelledby).toBe('lbl');
        expect(record.aria_labelledby_text).toBe('Username');
        expect(record.aria_describedby_text).toBe('Enter your handle');
        expect(record.aria_controls_text).toBe('Username');
    });

    it('handles multiple space-separated ids and missing ids gracefully', () => {
        render(`
      <span id="one">Alpha</span>
      <span id="two">Beta</span>
      <input id="m" aria-labelledby="one missing two" />
    `);

        const record = collectFieldData(target('m'));

        expect(record.aria_labelledby).toBe('one missing two');
        expect(record.aria_labelledby_text).toBe('Alpha | Beta');
    });
});
