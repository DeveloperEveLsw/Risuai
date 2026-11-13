<script lang="ts">
  import { CircleCheckIcon, Waypoints, XIcon } from "@lucide/svelte";
  import { onMount, onDestroy, untrack } from "svelte";
  import { language } from "src/lang";
  import Button from "src/lib/UI/GUI/Button.svelte";
  import TextInput from "src/lib/UI/GUI/TextInput.svelte";
  import {
    DBState,
    ReloadGUIPointer,
    selectedCharID,
    SettingsMenuIndex,
    settingsOpen,
  } from "src/ts/stores.svelte";
  import {
    browserRuntime,
    entityRuntimeEnabled,
    RuntimeUIState,
    reportRuntimeError,
  } from "src/ts/runtime/browserRuntimeState.svelte";
  import {
    getFieldValue,
    getSettingDatabase,
    setFieldValue,
  } from "src/ts/runtime/fieldControls";
  import type { FieldTarget } from "src/ts/runtime/fieldCommands";

  let {
    close = (_id: string) => {},
    alertMode = false,
  }: {
    close?: (id: string) => void;
    alertMode?: boolean;
  } = $props();
  let moduleSearch = $state("");
  let loadingMore = $state(false);
  let searchTimer: ReturnType<typeof setTimeout>;
  // This popup belongs to the character/chat that opened it, even if navigation
  // changes while a catalog request or selection is pending.
  const owner = untrack(() => {
    const character = DBState.db.characters[$selectedCharID];
    const chat = character?.chats[character.chatPage];
    return { characterId: character?.chaId, chatId: chat?.id };
  });
  const currentCharacter = () =>
    entityRuntimeEnabled
      ? DBState.db.characters.find((c) => c.chaId === owner.characterId)
      : DBState.db.characters[$selectedCharID];
  const currentChat = () =>
    entityRuntimeEnabled
      ? currentCharacter()?.chats.find((c) => c.id === owner.chatId)
      : currentCharacter()?.chats[currentCharacter()?.chatPage];
  const effectiveSettings = $derived(getSettingDatabase(DBState.db));
  const visibleModules = $derived(
    entityRuntimeEnabled
      ? (RuntimeUIState.libraries.module ?? []).map((item) => ({
          id: item.id,
          ...item.summary,
        }))
      : DBState.db.modules,
  );
  function modules(scope: "character" | "chat") {
    const value = scope === "character" ? currentCharacter() : currentChat();
    if (!value) return [];
    const target: FieldTarget = {
      scope,
      entityId: scope === "character" ? owner.characterId : owner.chatId,
      key: "modules",
    };
    return getFieldValue(target, value.modules) ?? [];
  }
  function toggle(scope: "character" | "chat", id: string) {
    if (effectiveSettings.enabledModules.includes(id)) return;
    const value = scope === "character" ? currentCharacter() : currentChat();
    if (!value) return;
    const existing = modules(scope);
    const next = existing.includes(id)
      ? existing.filter((m) => m !== id)
      : [...existing, id];
    try {
      setFieldValue(
        {
          scope,
          entityId: scope === "character" ? owner.characterId : owner.chatId,
          key: "modules",
        },
        next,
        () => {
          value.modules = next;
          $ReloadGUIPointer += 1;
        },
      );
    } catch (error) {
      reportRuntimeError(error);
    }
  }
  function search(value: string) {
    moduleSearch = value;
    if (!entityRuntimeEnabled) return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      void browserRuntime()
        .loadLibrary("module", value)
        .catch(reportRuntimeError);
    }, 150);
  }
  onMount(() => {
    if (entityRuntimeEnabled)
      void browserRuntime().loadLibrary("module").catch(reportRuntimeError);
  });
  onDestroy(() => {
    clearTimeout(searchTimer);
    if (entityRuntimeEnabled) browserRuntime().closeLibrary("module");
  });
  const sortedModules = $derived(
    visibleModules
      .filter((m) => m.name.toLowerCase().includes(moduleSearch.toLowerCase()))
      .toSorted((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
      ),
  );
</script>

<div
  data-runtime-module-picker
  class="absolute w-full h-full z-40 bg-black/50 flex justify-center items-center"
>
  <div
    class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-full max-h-full overflow-y-auto"
  >
    <div class="flex items-center text-textcolor">
      <h2 class="mt-0 mb-0 text-lg">{language.modules}</h2>
      <div class="grow flex justify-end">
        <button
          data-runtime-module-picker-close
          class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer items-center"
          onclick={() => close("")}><XIcon size={24} /></button
        >
      </div>
    </div>
    <span class="text-sm text-textcolor2">{language.chatModulesInfo}</span>
    <TextInput
      id="runtime-chat-module-search"
      className="mt-4"
      placeholder={language.search}
      bind:value={() => moduleSearch, search}
    />
    <div
      class="contain w-full max-w-full mt-4 flex flex-col border-selected border-1 rounded-md"
    >
      {#if sortedModules.length === 0}
        <div class="text-textcolor2 p-3">{language.noModules}</div>
      {:else}
        {#each sortedModules as module, i (module.id)}
          {#if i !== 0}<div class="border-t-1 border-selected"></div>{/if}
          <div
            data-module-picker-id={module.id}
            class="pl-3 py-3 text-left flex items-center"
          >
            {#if module.mcp}<Waypoints size={18} class="mr-2" />{/if}
            <span
              class:text-textcolor2={!alertMode &&
                effectiveSettings.enabledModules.includes(module.id)}
              >{module.name}</span
            >
            <div class="grow flex justify-end">
              {#if alertMode}
                <button
                  data-runtime-module-action="select"
                  class="text-textcolor2 mr-2 cursor-pointer hover:text-blue-500 transition-colors"
                  onclick={(e) => {
                    e.stopPropagation();
                    close(module.id);
                  }}><CircleCheckIcon size={18} /></button
                >
              {:else if effectiveSettings.enabledModules.includes(module.id)}
                <button
                  disabled
                  aria-label={language.enableGlobal}
                  class="mr-2 text-textcolor2 cursor-not-allowed"
                ></button>
              {:else}
                <button
                  data-runtime-module-action="toggle"
                  class={modules("chat").includes(module.id)
                    ? "mr-2 cursor-pointer text-blue-500"
                    : modules("character").includes(module.id)
                      ? "mr-2 cursor-pointer text-violet-500"
                      : "text-textcolor2 hover:text-blue-400 mr-2 cursor-pointer"}
                  onclick={(e) => {
                    e.stopPropagation();
                    toggle("chat", module.id);
                  }}
                  oncontextmenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggle("character", module.id);
                  }}><CircleCheckIcon size={18} /></button
                >
              {/if}
            </div>
          </div>
        {/each}
      {/if}
    </div>
    {#if entityRuntimeEnabled && RuntimeUIState.libraryNext.module}
      <Button
        disabled={loadingMore}
        className="mt-2"
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
    <div>
      <Button
        className="mt-4 grow-0"
        size="sm"
        onclick={() => {
          $SettingsMenuIndex = 14;
          $settingsOpen = true;
          close("");
        }}>{language.edit}</Button
      >
    </div>
  </div>
</div>

<style>
  .break-any {
    word-break: normal;
    overflow-wrap: anywhere;
  }
</style>
