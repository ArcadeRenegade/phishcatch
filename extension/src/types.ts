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

export interface Prefs {
    data_expiry: number;
    display_reuse_alerts: boolean;
    enable_debug_gui: boolean;
    enterprise_domains: string[];
    expire_hash_on_use: boolean;
    faq_link: string | null;
    hash_truncation_amount: number;
    ignored_domains: string[];
    manual_password_entry: boolean;
    pbkdf2_iterations: number;
    phishcatch_server: string;
    psk: string;
    repo_link: string | null;
    url_sanitization_level: UrlSanitizationEnum;
    username_selectors: string[];
    username_regexes: string[];
    banned_urls: string[];
}

export enum UrlSanitizationEnum {
    host = 'host',
    path = 'path',
    none = 'none',
}

export interface PageMessage {
    msgtype: 'username' | 'password' | 'debug' | 'domstring' | 'collectFieldData' | 'runInference' | 'offscreenInference' | 'aiPromptSubmission';
    content: PasswordContent | UsernameContent | DomstringContent | CollectFieldDataContent | InferenceRequestContent | AiPromptSubmissionContent | string;
    // Set on messages the service worker forwards to the offscreen document so
    // other extension contexts (popup) ignore them.
    target?: 'offscreen';
}

// Telemetry emitted when a user submits text into an element classified as an AI
// prompt. Mirrors the password telemetry pattern: the raw typed text is NEVER
// sent (parity with hashed passwords) - only sanitized metadata is dispatched.
export interface AiPromptSubmissionContent {
    url: string;
    referrer: string;
    timestamp: number;
}

export interface CollectFieldDataContent {
    fields: RawFieldData[];
}

// Pre-formatted features sent from the content script to the background service
// worker for ONNX inference. Plain JSON-serializable types only (chrome
// messaging uses JSON), so booleans are number[] (1/0) - the SW rebuilds the
// Float32Array. Arrays follow feature_schema boolean_keys / categorical_keys order.
export interface InferenceRequestContent {
    booleans: number[];
    categorical: string[];
    combined_text: string;
}

// Flat, human-readable record describing a single interactive text element.
// Intentionally data-minimized: it never includes the element `value` or the
// element's own typed `textContent` (which would be a user payload). All values
// are primitives so the record stays a flat key/value object for LLM labeling.
export interface RawFieldData {
    // label - left null at collection time, filled in during offline labeling
    is_ai_prompt: boolean | null;
    // metadata
    collected_url: string;
    collected_at: number;
    // structural / ARIA booleans
    tag_name: string;
    type: string;
    role: string;
    read_only: boolean;
    disabled: boolean;
    required: boolean;
    is_content_editable: boolean;
    aria_expanded: string;
    aria_haspopup: string;
    // attribute text
    id: string;
    name: string;
    class_name: string;
    placeholder: string;
    data_placeholder: string;
    data_test_id: string;
    data_testid: string;
    autocomplete: string;
    aria_label: string;
    aria_placeholder: string;
    aria_roledescription: string;
    title: string;
    // raw aria-relation id references
    aria_labelledby: string;
    aria_describedby: string;
    aria_controls: string;
    aria_errormessage: string;
    // resolved aria-relation text content
    aria_labelledby_text: string;
    aria_describedby_text: string;
    aria_controls_text: string;
    aria_errormessage_text: string;
    // adapted from reference extraction logic
    official_label_text: string;
    fuzzy_parent_text: string;
    button_text: string;
    form_control_name: string;
    dataset_attributes: string;
}

export interface PasswordContent {
    password: string;
    save: boolean;
    url: string;
    referrer: string;
    timestamp: number;
    username?: string;
}

export enum AlertTypes {
    REUSE = 'reuse',
    DOMHASH = 'domhash',
    USERREPORT = 'userreport',
    FALSEPOSITIVE = 'falsepositive',
    PERSONALPASSWORD = 'personalpassword',
    AIPROMPT = 'aiprompt',
}

export interface AlertContent {
    url: string;
    referrer: string;
    timestamp: number;
    alertType: AlertTypes;
    associatedUsername?: string;
    associatedHostname?: string;
}

export interface UsernameContent {
    username: string;
    url: string;
    dom: string;
}

export interface DomstringContent {
    dom: string;
    url: string;
}

export type DebugContent = string;

export interface TLSHInstance {
    update(str: string, length?: number): any;
    finale(str?: string, length?: number): any;
    hash(): string;
    reset(): undefined;
    totalDiff(instance: TLSHInstance, len_diff?: number): number;
    fromTlshStr(str: string): undefined;

    checksum: Uint8Array;
    slide_window: Uint8Array;
    a_bucket: Uint32Array;
    data_len: number;
    tmp_code: Uint8Array;
    Lvalue: number;
    Q: number;
    lsh_code: string;
    lsh_code_valid: boolean;
}

export interface TLSHQuartile {
    q1: number;
    q2: number;
    q3: number;
}

export interface Username {
    username: string;
    dateAdded: number;
}

export interface PasswordHash {
    hash: string;
    salt: string;
    dateAdded: number;
    username?: string;
    hostname?: string;
}

export enum PasswordHandlingReturnValue {
    EnterpriseNoSave,
    EnterpriseSave,
    IgnoredDomain,
    NoReuse,
    ReuseAlert,
}

export enum DomainType {
    ENTERPRISE = 'ENTERPRISE',
    IGNORED = 'IGNORED',
    DANGEROUS = 'DANGEROUS',
}

export interface DatedDomHash {
    hash: string;
    dateAdded: number;
    source: string;
}

export interface NotificationData {
    id: string;
    hash: string;
    url: string;
}
