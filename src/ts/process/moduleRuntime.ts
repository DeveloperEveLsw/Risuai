import { get } from "svelte/store";
import type { RisuModule } from "./modules";
import type { language } from "src/lang";
import type {
  alertClear,
  alertConfirm,
  alertError,
  alertModuleSelect,
  alertNormal,
  alertStore,
  alertWait,
} from "../alert";
import type {
  getCurrentCharacter,
  getCurrentChat,
  getDatabase,
  setCurrentCharacter,
  setDatabase,
  customscript,
  loreBook,
  triggerscript,
} from "../storage/database.svelte";
import type {
  AppendableBuffer,
  downloadFile,
  forageStorage,
  LocalWriter,
  readImage,
  saveAsset,
  VirtualWriter,
} from "../globalApi.svelte";
import type { checkPersonaBinded, selectSingleFile, sleep } from "../util";
import type { v4 } from "uuid";
import type { convertExternalLorebook } from "./lorebook.svelte";
import type { compressImage } from "../media";
import type { decodeRPack, encodeRPack } from "../rpack/rpack_js";
import type {
  DBState,
  HideIconStore,
  moduleBackgroundEmbedding,
  ReloadGUIPointer,
} from "../stores.svelte";
import type {
  convertCharacterToModule,
  convertModuleToCharacter,
} from "../interchangeability";
import type {
  exportCharacterCard,
  importCharacterProcess,
} from "../characterCards";

/** Original upstream operations, with per-context state and injected capabilities. */
export interface ModuleRuntimeHost {
  readResourceValue: <T>(value: T) => T;
  getDatabase: (typeof import("../storage/database.svelte"))["getDatabase"];
  checkPersonaBinded: (typeof import("../util"))["checkPersonaBinded"];
  getCurrentChat: (typeof import("../storage/database.svelte"))["getCurrentChat"];
  getCurrentCharacter: (typeof import("../storage/database.svelte"))["getCurrentCharacter"];
}

export function createModuleRuntime(host: ModuleRuntimeHost) {
  function getModuleById(id: string) {
    const db = host.getDatabase();
    for (let i = 0; i < db.modules.length; i++) {
      if (db.modules[i].id === id) {
        return host.readResourceValue(db.modules[i]);
      }
    }
    if (id === "$embedded") {
      const persona = host.checkPersonaBinded();
      if (persona && persona.embeddedModule) {
        return host.readResourceValue(persona.embeddedModule);
      }
    }
    return null;
  }

  function getModuleByIds(ids: string[]) {
    const db = host.getDatabase();
    const idSet = new Set(ids);
    const modules = db.modules.filter(
      (m) => idSet.has(m.id) || (m.namespace && idSet.has(m.namespace)),
    );
    return host.readResourceValue(deduplicateModuleById(modules));
  }

  function deduplicateModuleById(modules: RisuModule[]) {
    let ids: string[] = [];
    let newModules: RisuModule[] = [];
    for (let i = 0; i < modules.length; i++) {
      if (ids.includes(modules[i].id)) {
        continue;
      }
      ids.push(modules[i].id);
      newModules.push(modules[i]);
    }
    return newModules;
  }

  let lastModules = "";

  let lastModuleData: RisuModule[] = [];

  function getModules() {
    const currentChat = host.getCurrentChat();
    const character = host.getCurrentCharacter();
    const persona = host.checkPersonaBinded();
    const db = host.getDatabase();
    let ids = db.enabledModules ?? [];
    if (currentChat) {
      ids = ids.concat(currentChat.modules ?? []);
    }
    if (character && character.modules) {
      ids = ids.concat(character.modules);
    }
    if (persona && persona.embeddedModule) {
      ids = ids.concat([persona.embeddedModule?.id]);
    }
    if (db.moduleIntergration) {
      const intList = db.moduleIntergration.split(",").map((s) => s.trim());
      ids = ids.concat(intList);
    }
    const idsJoined = ids.join("-");
    if (lastModules === idsJoined) {
      return lastModuleData;
    }
    let modules: RisuModule[] = getModuleByIds(ids);
    lastModules = idsJoined;
    lastModuleData = modules;
    return modules;
  }

  function getModuleLorebooks() {
    const modules = getModules();
    let lorebooks: loreBook[] = [];
    for (const module of modules) {
      if (!module) {
        continue;
      }
      if (module.lorebook) {
        lorebooks = lorebooks.concat(module.lorebook);
      }
    }
    return lorebooks;
  }

  function getModuleAssets() {
    const modules = getModules();
    let assets: [string, string, string][] = [];
    for (const module of modules) {
      if (!module) {
        continue;
      }
      if (module.assets) {
        assets = assets.concat(module.assets);
      }
    }
    return assets;
  }

  function getModuleTriggers() {
    const modules = getModules();
    let triggers: triggerscript[] = [];
    for (const module of modules) {
      if (!module) {
        continue;
      }
      if (module.trigger) {
        triggers = triggers.concat(
          module.trigger.map((t) => {
            t.lowLevelAccess = module.lowLevelAccess;
            return t;
          }),
        );
      }
    }
    return triggers;
  }

  function getModuleRegexScripts() {
    const modules = getModules();
    let customscripts: customscript[] = [];
    for (const module of modules) {
      if (!module) {
        continue;
      }
      if (module.regex) {
        customscripts = customscripts.concat(module.regex);
      }
    }
    return customscripts;
  }

  function getModuleToggles() {
    const modules = getModules();
    let costomModuleToggles: string = "";
    for (const module of modules) {
      if (!module) {
        continue;
      }
      if (module.customModuleToggle) {
        costomModuleToggles += "\n" + module.customModuleToggle + "\n";
      }
    }
    return costomModuleToggles;
  }

  function getModuleMcps() {
    const modules = getModules();
    return modules.map((v) => v.mcp?.url).filter((v) => v);
  }

  function refreshModules() {
    lastModules = "";
    lastModuleData = [];
  }
  return {
    getModuleById,
    getModuleByIds,
    deduplicateModuleById,
    getModules,
    getModuleLorebooks,
    getModuleAssets,
    getModuleTriggers,
    getModuleRegexScripts,
    getModuleToggles,
    getModuleMcps,
    refreshModules,
  };
}
