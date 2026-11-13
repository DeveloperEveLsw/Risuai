"use strict";

const FLOAT_DISABLE_KEY = "wl.cbs-toggle-disable";

/** The reviewed plugin itself offers this escape flag for its main-window
 * floating shortcut. A server realm has no Risu browser main window. Read the
 * flag ephemerally, without writing a setting, user storage, or graph value.
 * Other private-window storage operations retain their original behavior.
 */
function createWyglorePresentationStorage(storage, unsupported) {
  const release = () =>
    unsupported(
      "The original floating shortcut requires a browser main window; release of server suppression is unavailable",
      "PLUGIN_UI_CAPABILITY_REQUIRED",
    );
  return Object.freeze({
    get length() {
      return storage?.length ?? 0;
    },
    key(index) {
      return storage?.key(index) ?? null;
    },
    getItem(key) {
      return String(key) === FLOAT_DISABLE_KEY
        ? "1"
        : (storage?.getItem(key) ?? null);
    },
    setItem(key, value) {
      if (String(key) === FLOAT_DISABLE_KEY) {
        if (String(value) !== "1") return release();
        return;
      }
      if (!storage)
        return unsupported("Private-window localStorage is unavailable");
      return storage.setItem(key, value);
    },
    removeItem(key) {
      if (String(key) === FLOAT_DISABLE_KEY) return release();
      if (!storage)
        return unsupported("Private-window localStorage is unavailable");
      return storage.removeItem(key);
    },
    clear() {
      if (!storage)
        return unsupported("Private-window localStorage is unavailable");
      return storage.clear();
    },
  });
}

module.exports = { FLOAT_DISABLE_KEY, createWyglorePresentationStorage };
