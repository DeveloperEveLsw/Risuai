"use strict";
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { LuaFactory } = require("wasmoon");

let preparedFactory,
  preparing,
  taken = false;

/** Prepare only immutable public code/WASM. No job, database or plugin is read. */
async function prepare(options = {}) {
  if (taken) throw new Error("Button preparation was already consumed");
  if (preparing) return preparing;
  preparing = (async () => {
    await import(
      pathToFileURL(
        options.bundlePath ?? join(__dirname, "dist/extensionJob.mjs"),
      ).href
    );
    const factory = new LuaFactory();
    await factory.mountFile(
      "json.lua",
      await readFile(
        options.jsonPath ?? join(__dirname, "../../public/lua/json.lua"),
        "utf8",
      ),
    );
    const probe = await factory.createEngine({ injectObjects: true });
    try {
      if ((await probe.doString("return 1")) !== 1)
        throw new Error("Button WASM preparation failed");
    } finally {
      probe.global.close();
    }
    preparedFactory = factory;
    return true;
  })();
  return preparing;
}

/** A constructor capability consumed by one fresh scripting runtime only. */
function takeFactory() {
  if (!preparedFactory || taken) return undefined;
  const factory = preparedFactory;
  preparedFactory = undefined;
  taken = true;
  let constructed = false;
  return function PreparedButtonLuaFactory() {
    if (constructed)
      throw new Error("Prepared button factory cannot be reused");
    constructed = true;
    return factory;
  };
}

module.exports = { prepare, takeFactory };
