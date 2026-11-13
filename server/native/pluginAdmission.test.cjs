"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  pluginRequiresServerHost,
  MODULE_MANAGER_SHA256,
} = require("./pluginAdmission.cjs");
const fixture = () => ({
  name: "module-manager",
  version: "3.0",
  enabled: true,
  script: "Synthetic reviewed fingerprint fixture, not a copied private bundle",
  realArg: { debug: 0, global_presets: "", persona_modules: "" },
});
test("only the reviewed inert configuration is admitted; defaults and changed code stay blocked", () => {
  const plugin = fixture(),
    reviewed = () => MODULE_MANAGER_SHA256;
  assert.equal(pluginRequiresServerHost(plugin, {}, reviewed), false);
  assert.equal(pluginRequiresServerHost(plugin, {}), true);
  assert.equal(
    pluginRequiresServerHost({ ...plugin, name: "unknown" }, {}, reviewed),
    true,
  );
  assert.equal(
    pluginRequiresServerHost({ ...plugin, version: "2.1" }, {}, reviewed),
    true,
  );
  for (const key of ["global_presets", "persona_modules"])
    for (const value of ["{}", '{"synthetic":[]}', null, undefined])
      assert.equal(
        pluginRequiresServerHost(
          { ...plugin, realArg: { ...plugin.realArg, [key]: value } },
          {},
          reviewed,
        ),
        true,
      );
  assert.equal(
    pluginRequiresServerHost(
      { ...plugin, realArg: { ...plugin.realArg, unknown: true } },
      {},
      reviewed,
    ),
    true,
  );
  for (const injected of ["invalid", [], { synthetic: [] }])
    assert.equal(
      pluginRequiresServerHost(
        plugin,
        { pluginCustomStorage: { personaInjectedToChar: injected } },
        reviewed,
      ),
      true,
    );
  assert.equal(
    pluginRequiresServerHost(
      plugin,
      { pluginCustomStorage: { personaInjectedToChar: {} } },
      reviewed,
    ),
    false,
  );
});
test("disabled plugins need no execution host regardless of their code or arguments", () => {
  assert.equal(
    pluginRequiresServerHost(
      { ...fixture(), enabled: false, script: "unknown", realArg: {} },
      {},
    ),
    false,
  );
});
