/* eslint-disable no-var */

// Console-callable globals registered by the background service worker
// (see lib/dataCollectionLog.ts -> registerDataCollectionGlobals). Declared as
// `var` so they are assignable via globalThis.

declare var enableDataCollection: () => Promise<void>;
declare var disableDataCollection: () => Promise<void>;
declare var downloadDataCollectionLog: () => Promise<void>;
