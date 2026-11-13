<script lang="ts">
  import { language } from "src/lang";

  import { DBState } from "src/ts/stores.svelte";
  import Button from "src/lib/UI/GUI/Button.svelte";
  import ModuleMenu from "src/lib/Setting/Pages/Module/ModuleMenu.svelte";
  import {
    exportModule,
    exportModuleLegacy,
    importModule,
    refreshModules,
    type RisuModule,
  } from "src/ts/process/modules";
  import {
    SquarePen,
    TrashIcon,
    Globe,
    Share2Icon,
    PlusIcon,
    HardDriveUpload,
    Waypoints,
    UserIcon,
  } from "@lucide/svelte";
  import { v4 } from "uuid";
  import { tooltip } from "src/ts/gui/tooltip";
  import { alertConfirm, alertNormal, alertSelect } from "src/ts/alert";
  import TextInput from "src/lib/UI/GUI/TextInput.svelte";
  import { onDestroy, onMount } from "svelte";
  import {
    entityRuntimeEnabled,
    RuntimeUIState,
    browserRuntime,
    reportRuntimeError,
  } from "src/ts/runtime/browserRuntimeState.svelte";
  import {
    getSettingDatabase,
    setSettingValues,
  } from "src/ts/runtime/fieldControls";
  import { createServerCharacter } from "src/ts/characters";
  import { importMCPModule } from "src/ts/process/mcp/mcp";
  import { convertModuleToCharacter } from "src/ts/interchangeability";
  import { checkCharOrder } from "src/ts/globalApi.svelte";
  let tempModule: RisuModule = $state({
    name: "",
    description: "",
    id: v4(),
  });
  let mode = $state(0);
  let editModuleIndex = $state(-1);
  let moduleSearch = $state("");
  let charConversionMode = $state(false);
  let effectiveSettings = $derived(getSettingDatabase(DBState.db));
  let editHeader = { revision: 0, epoch: 0 };
  let saving = $state(false);
  let loadingMore = $state(false);
  let searchTimer: ReturnType<typeof setTimeout>;
  let visibleModules = $derived(
    entityRuntimeEnabled
      ? (RuntimeUIState.libraries.module ?? []).map((item) => ({
          id: item.id,
          ...item.summary,
        }))
      : DBState.db.modules,
  );
  function searchModules(value: string) {
    moduleSearch = value;
    if (!entityRuntimeEnabled) return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      void browserRuntime()
        .loadLibrary("module", value)
        .catch(reportRuntimeError);
    }, 150);
  }
  async function fullModule(id: string) {
    if (entityRuntimeEnabled)
      return (await browserRuntime().getLibraryResource("module", id))
        .payload as unknown as RisuModule;
    return DBState.db.modules.find((value) => value.id === id);
  }
  onMount(() => {
    if (entityRuntimeEnabled)
      void browserRuntime().loadLibrary("module").catch(reportRuntimeError);
  });
  async function saveModule() {
    if (!entityRuntimeEnabled) {
      if (mode === 2) DBState.db.modules[editModuleIndex] = tempModule;
      mode = 0;
      return;
    }
    if (saving) return;
    if (!tempModule.name) {
      mode = 0;
      return;
    }
    saving = true;
    try {
      await browserRuntime().saveLibraryResource(
        "module",
        { ...$state.snapshot(tempModule) },
        mode === 2 ? editHeader : { revision: 0, epoch: 0 },
      );
      mode = 0;
    } catch (error) {
      reportRuntimeError(error);
    } finally {
      saving = false;
    }
  }

  function sortModules(
    modules: {
      id: string;
      name: string;
      description?: string;
      namespace?: string;
      mcp?: unknown;
    }[],
    search: string,
  ) {
    return modules
      .filter((v) => {
        if (search === "") return true;
        return v.name.toLowerCase().includes(search.toLowerCase());
      })
      .sort((a, b) => {
        let score = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        return score;
      });
  }

  onDestroy(() => {
    clearTimeout(searchTimer);
    if (entityRuntimeEnabled) browserRuntime().closeLibrary("module");
    refreshModules();
  });
</script>

{#if mode === 0}
  <h2 class="mb-2 text-2xl font-bold mt-2">{language.modules}</h2>

  <TextInput
    id="runtime-module-search"
    className="mt-4"
    placeholder={language.search}
    bind:value={() => moduleSearch, searchModules}
  />

  <div
    class="contain w-full max-w-full mt-4 flex flex-col border-selected border-1 rounded-md flex-1 overflow-y-auto"
  >
    {#if visibleModules.length === 0}
      <div class="text-textcolor2 p-3">{language.noModules}</div>
    {:else}
      {#each sortModules(visibleModules, moduleSearch) as rmodule, i (rmodule.id)}
        {#if i !== 0}
          <div class="border-t-1 border-selected"></div>
        {/if}

        <div
          class="pl-3 pt-3 text-left flex items-center"
          data-module-id={rmodule.id}
        >
          {#if rmodule.mcp}
            <Waypoints size={18} class="mr-2" />
          {/if}
          <span class="text-lg">{rmodule.name}</span>
          <div class="grow flex justify-end">
            {#if charConversionMode}
              <button
                class="cursor-pointer text-violet-500 mr-2"
                onclick={async (e) => {
                  e.stopPropagation();
                  try {
                    const module = await fullModule(rmodule.id);
                    const char = convertModuleToCharacter(module);
                    if (entityRuntimeEnabled) await createServerCharacter(char);
                    else {
                      DBState.db.characters.push(char);
                      checkCharOrder();
                    }
                    alertNormal(language.successfullyConverted);
                  } catch (error) {
                    reportRuntimeError(error);
                  }
                }}
              >
                <UserIcon size={18} />
              </button>
            {:else}
              <button
                aria-label={language.enableGlobal}
                class={effectiveSettings.enabledModules.includes(rmodule.id)
                  ? "mr-2 cursor-pointer text-blue-500"
                  : rmodule.namespace &&
                      DBState.db.moduleIntergration
                        ?.split(",")
                        .map((s) => s.trim())
                        .includes(rmodule.namespace)
                    ? "text-amber-500 hover:text-green-500 mr-2 cursor-pointer"
                    : "text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"}
                use:tooltip={language.enableGlobal}
                onclick={async (e) => {
                  e.stopPropagation();
                  if (entityRuntimeEnabled) {
                    const enabled = effectiveSettings.enabledModules;
                    setSettingValues(
                      DBState.db,
                      new Map([
                        [
                          "enabledModules",
                          enabled.includes(rmodule.id)
                            ? enabled.filter((id) => id !== rmodule.id)
                            : [...enabled, rmodule.id],
                        ],
                      ]),
                    );
                    charConversionMode = false;
                    return;
                  }
                  if (DBState.db.enabledModules.includes(rmodule.id)) {
                    DBState.db.enabledModules.splice(
                      DBState.db.enabledModules.indexOf(rmodule.id),
                      1,
                    );
                  } else {
                    DBState.db.enabledModules.push(rmodule.id);
                  }
                  DBState.db.enabledModules = DBState.db.enabledModules;
                  charConversionMode = false;
                }}
              >
                <Globe size={18} />
              </button>
              {#if !rmodule.mcp}
                <button
                  class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
                  use:tooltip={language.download}
                  onclick={async (e) => {
                    e.stopPropagation();
                    const sel = parseInt(
                      await alertSelect([
                        `CharX (${language.recommended})`,
                        `RisuM (Legacy)`,
                      ]),
                    );
                    try {
                      const module = await fullModule(rmodule.id);
                      if (sel === 0) await exportModule(module);
                      else await exportModuleLegacy(module);
                    } catch (error) {
                      reportRuntimeError(error);
                    }
                  }}
                >
                  <Share2Icon size={18} />
                </button>
                <button
                  aria-label={language.edit}
                  class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
                  use:tooltip={language.edit}
                  onclick={async (e) => {
                    e.stopPropagation();
                    const index = DBState.db.modules.findIndex(
                      (v) => v.id === rmodule.id,
                    );
                    try {
                      if (entityRuntimeEnabled) {
                        const resource =
                          await browserRuntime().getLibraryResource(
                            "module",
                            rmodule.id,
                          );
                        editHeader = resource.header;
                        tempModule = resource.payload as unknown as RisuModule;
                      } else {
                        editHeader = { revision: 0, epoch: 0 };
                        tempModule = DBState.db.modules[index];
                      }
                      editModuleIndex = index;
                      mode = 2;
                    } catch (error) {
                      reportRuntimeError(error);
                    }
                  }}
                >
                  <SquarePen size={18} />
                </button>
              {:else}
                <button class="text-textcolor2 mr-2 cursor-not-allowed">
                  <Share2Icon size={18} />
                </button>
                <button class="text-textcolor2 mr-2 cursor-not-allowed">
                  <SquarePen size={18} />
                </button>
              {/if}
              <button
                aria-label={language.remove}
                class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
                use:tooltip={language.remove}
                onclick={async (e) => {
                  e.stopPropagation();
                  const expected = entityRuntimeEnabled
                    ? browserRuntime().libraryHeader("module", rmodule.id)
                    : { revision: 0, epoch: 0 };
                  const d = await alertConfirm(
                    `${language.removeConfirm}` + rmodule.name,
                  );
                  if (d) {
                    if (entityRuntimeEnabled) {
                      try {
                        await browserRuntime().deleteLibraryResource(
                          "module",
                          rmodule.id,
                          expected,
                        );
                      } catch (error) {
                        reportRuntimeError(error);
                      }
                      return;
                    }
                    if (DBState.db.enabledModules.includes(rmodule.id)) {
                      DBState.db.enabledModules.splice(
                        DBState.db.enabledModules.indexOf(rmodule.id),
                        1,
                      );
                      DBState.db.enabledModules = DBState.db.enabledModules;
                    }
                    const index = DBState.db.modules.findIndex(
                      (v) => v.id === rmodule.id,
                    );
                    DBState.db.modules.splice(index, 1);
                    DBState.db.modules = DBState.db.modules;
                  }
                }}
              >
                <TrashIcon size={18} />
              </button>
            {/if}
          </div>
        </div>
        <div class="mt-1 mb-3 pl-3">
          <span class="text-sm text-textcolor2"
            >{rmodule.description || "No description provided"}</span
          >
        </div>
      {/each}
    {/if}
  </div>

  {#if entityRuntimeEnabled && RuntimeUIState.libraryNext.module}
    <Button
      disabled={loadingMore}
      onclick={async () => {
        loadingMore = true;
        try {
          await browserRuntime().loadLibraryMore("module");
        } catch (error) {
          reportRuntimeError(error);
        } finally {
          loadingMore = false;
        }
      }}>{language.loadMore}</Button
    >
  {/if}

  <div class="flex mr-2 mt-4">
    <button
      aria-label={language.createModule}
      class="text-textcolor2 hover:text-blue-500 mr-2 cursor-pointer"
      onclick={async () => {
        tempModule = {
          name: "",
          description: "",
          id: v4(),
        };
        if (!entityRuntimeEnabled) DBState.db.modules.push(tempModule);
        mode = 1;
      }}
    >
      <PlusIcon />
    </button>
    <button
      class="text-textcolor2 hover:text-blue-500 mr-2 cursor-pointer"
      onclick={async () => {
        charConversionMode = !charConversionMode;
      }}
    >
      <UserIcon />
    </button>
    <button
      class="text-textcolor2 hover:text-blue-500 mr-2 cursor-pointer"
      onclick={async () => {
        importMCPModule();
      }}
    >
      <Waypoints />
    </button>
    <button
      class="text-textcolor2 hover:text-blue-500 mr-2 cursor-pointer"
      onclick={async () => {
        importModule();
      }}
    >
      <HardDriveUpload />
    </button>
  </div>
{:else if mode === 1}
  <h2 class="mb-2 text-2xl font-bold mt-2">{language.createModule}</h2>
  <ModuleMenu bind:currentModule={tempModule} />
  <Button className="mt-6" disabled={saving} onclick={saveModule}
    >{entityRuntimeEnabled ? language.createModule : language.close}</Button
  >
{:else if mode === 2}
  <h2 class="mb-2 text-2xl font-bold mt-2">{language.editModule}</h2>
  <ModuleMenu bind:currentModule={tempModule} />
  {#if tempModule.name !== ""}
    <Button className="mt-6" disabled={saving} onclick={saveModule}
      >{language.editModule}</Button
    >
  {/if}
{/if}
