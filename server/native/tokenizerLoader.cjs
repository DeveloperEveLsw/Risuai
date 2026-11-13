"use strict";
const { readFileSync } = require("node:fs");
const { compileFunction, constants } = require("node:vm");
const { dirname } = require("node:path");
const { createRequire } = require("node:module");
let loaded;

/** The installed 0.1.6 package declares ESM but ships UMD using CommonJS globals.
 * Evaluate its unchanged, trusted package file with those module-local bindings.
 * No browser, copied tokenizer, dependency edit, or process-global require is needed.
 */
async function loadWebTokenizers() {
  if (!loaded) {
    const file = require.resolve("@mlc-ai/web-tokenizers");
    const module = { exports: {} };
    compileFunction(
      readFileSync(file, "utf8"),
      ["exports", "require", "module", "__filename", "__dirname"],
      {
        filename: file,
        importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
      },
    )(module.exports, createRequire(file), module, file, dirname(file));
    if (typeof module.exports.Tokenizer?.fromJSON !== "function")
      throw new Error("Invalid native tokenizer module exports");
    loaded = module.exports;
  }
  return loaded;
}
module.exports = { loadWebTokenizers };
