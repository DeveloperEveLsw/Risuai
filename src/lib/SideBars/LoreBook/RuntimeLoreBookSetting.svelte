<script lang="ts">
  import { v4 } from "uuid";
  import {
    DownloadIcon,
    HardDriveUploadIcon,
    PlusIcon,
    SunIcon,
    LinkIcon,
    FolderPlusIcon,
  } from "@lucide/svelte";
  import { language } from "src/lang";
  import { DBState } from "src/ts/stores.svelte";
  import type { loreBook } from "src/ts/storage/database.svelte";
  import type { LoreEditorContext } from "src/ts/runtime/loreEditor";
  import { convertExternalLorebook } from "src/ts/process/lorebook.svelte";
  import { selectSingleFile } from "src/ts/util";
  import { downloadFile } from "src/ts/globalApi.svelte";
  import { alertError, alertNormal } from "src/ts/alert";
  import Check from "src/lib/UI/GUI/CheckInput.svelte";
  import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
  import Help from "src/lib/Others/Help.svelte";
  import LoreBookList from "./LoreBookList.svelte";

  let {
    values,
    capture,
    characterType,
  }: {
    values: any;
    capture: (names: string[]) => {
      values: any;
      commit: (values: Record<string, unknown>) => void;
    };
    characterType: string;
  } = $props();
  let submenu = $state(0);
  const field = () => (submenu === 0 ? "globalLore" : "localLore");
  const context = $derived({
    characterLore: () => values.globalLore,
    chatLore: () => values.localLore,
    setChatLore: (value: loreBook[]) => {
      values.localLore = value;
    },
    isCharacterLore: submenu === 0,
    captureRemoval: () => {
      const original = capture(["globalLore", "localLore"]);
      return () => original.commit(original.values);
    },
  } satisfies LoreEditorContext);
  function add(folder = false) {
    const collection = values[field()];
    collection.push({
      key: folder ? "\uf000folder:" + v4() : "",
      comment: folder ? "New Folder" : `New Lore ${collection.length + 1}`,
      content: "",
      mode: folder ? "folder" : "normal",
      insertorder: 100,
      alwaysActive: false,
      secondkey: "",
      selective: false,
    });
  }
  function toggleAll(key: string) {
    const all = values[key].every((book: loreBook) => book.alwaysActive);
    for (const book of values[key]) book.alwaysActive = !all;
  }
  async function importFile() {
    try {
      const key = field(),
        original = capture([key]);
      const file = await selectSingleFile(["json", "lorebook"]);
      if (!file?.data) return;
      const imported = JSON.parse(Buffer.from(file.data).toString("utf-8"));
      const additions =
        imported.type === "risu" && Array.isArray(imported.data)
          ? imported.data
          : imported.entries
            ? convertExternalLorebook(imported.entries)
            : null;
      if (!additions) throw new Error("Unsupported lorebook format");
      original.values[key].push(...additions);
      original.commit(original.values);
    } catch (error) {
      alertError(error);
    }
  }
  async function exportFile() {
    try {
      const data = JSON.parse(JSON.stringify(values[field()]));
      await downloadFile(
        "lorebook_export.json",
        Buffer.from(JSON.stringify({ type: "risu", ver: 1, data }), "utf-8"),
      );
      alertNormal(language.successExport);
    } catch (error) {
      alertError(error);
    }
  }
</script>

<div data-runtime-lorebook>
  <div class="flex w-full rounded-md border border-selected">
    <button
      class="p-2 flex-1"
      class:bg-selected={submenu === 0}
      onclick={() => {
        submenu = 0;
      }}
      >{characterType === "group" ? language.group : language.character}</button
    >
    <button
      class="p2 flex-1 border-r border-l border-selected"
      class:bg-selected={submenu === 1}
      onclick={() => {
        submenu = 1;
      }}>{language.Chat}</button
    >
    <button
      class="p-2 flex-1"
      class:bg-selected={submenu === 2}
      onclick={() => {
        submenu = 2;
      }}>{language.settings}</button
    >
  </div>
  {#if submenu !== 2}
    <span class="text-textcolor2 mt-2 mb-6 text-sm"
      >{submenu === 0
        ? characterType === "group"
          ? language.groupLoreInfo
          : language.globalLoreInfo
        : language.localLoreInfo}</span
    >
    {#if submenu === 0}
      <LoreBookList
        bind:externalLoreBooks={values.globalLore}
        lorePlus={values.lorePlus}
        loreContext={context}
      />
    {:else}
      <LoreBookList
        bind:externalLoreBooks={values.localLore}
        lorePlus={values.lorePlus}
        loreContext={context}
      />
    {/if}
    <div class="text-textcolor2 mt-2 flex">
      <button
        data-lore-action="add"
        class="hover:text-textcolor cursor-pointer"
        onclick={() => add()}><PlusIcon /></button
      >
      <button
        data-lore-action="export"
        class="hover:text-textcolor ml-1 cursor-pointer"
        onclick={exportFile}><DownloadIcon /></button
      >
      <button
        data-lore-action="folder"
        class="hover:text-textcolor ml-2 cursor-pointer"
        onclick={() => add(true)}><FolderPlusIcon /></button
      >
      <button
        data-lore-action="import"
        class="hover:text-textcolor ml-2 cursor-pointer"
        onclick={importFile}><HardDriveUploadIcon /></button
      >
      {#if DBState.db.bulkEnabling}
        {#each ["globalLore", "localLore"] as key}
          <button
            data-lore-action={key}
            class="hover:text-textcolor ml-2 cursor-pointer flex items-center gap-1"
            onclick={() => toggleAll(key)}
          >
            {#if values[key].every((book: loreBook) => book.alwaysActive)}<SunIcon
              />{:else}<LinkIcon />{/if}
            <span class="text-xs">{key === "globalLore" ? "CHAR" : "CHAT"}</span
            >
          </button>
        {/each}
      {/if}
    </div>
  {:else}
    {#if values.loreSettings}
      <div class="flex items-center mt-4">
        <Check
          check={false}
          onChange={() => {
            values.loreSettings = undefined;
          }}
          name={language.useGlobalSettings}
        />
      </div>
      <div class="flex items-center mt-4">
        <Check
          bind:check={values.loreSettings.recursiveScanning}
          name={language.recursiveScanning}
        />
      </div>
      <div class="flex items-center mt-4">
        <Check
          bind:check={
            () => values.loreSettings.fullWordMatching ?? false,
            (value) => {
              if (Boolean(values.loreSettings.fullWordMatching) !== value)
                values.loreSettings.fullWordMatching = value;
            }
          }
          name={language.fullWordMatching}
        />
      </div>
      <span class="text-textcolor mt-4 mb-2">{language.loreBookDepth}</span>
      <NumberInput
        size="sm"
        min={0}
        max={20}
        bind:value={values.loreSettings.scanDepth}
      />
      <span class="text-textcolor">{language.loreBookToken}</span>
      <NumberInput
        size="sm"
        min={0}
        max={4096}
        bind:value={values.loreSettings.tokenBudget}
      />
    {:else}
      <div class="flex items-center mt-4">
        <Check
          check={true}
          onChange={() => {
            values.loreSettings = {
              tokenBudget: DBState.db.loreBookToken,
              scanDepth: DBState.db.loreBookDepth,
              recursiveScanning: false,
            };
          }}
          name={language.useGlobalSettings}
        />
      </div>
    {/if}
    {#if DBState.db.useExperimental}
      <div class="flex items-center mt-4">
        <Check
          bind:check={
            () => values.lorePlus ?? false,
            (value) => {
              if (Boolean(values.lorePlus) !== value) values.lorePlus = value;
            }
          }
          name={language.lorePlus}
          ><Help key="lorePlus" /><Help key="experimental" /></Check
        >
      </div>
    {/if}
  {/if}
</div>
