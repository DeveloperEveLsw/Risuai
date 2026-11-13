<script lang="ts">
  import { language } from "src/lang";
  import BaseRoundedButton from "src/lib/UI/BaseRoundedButton.svelte";
  import Button from "src/lib/UI/GUI/Button.svelte";
  import Check from "src/lib/UI/GUI/CheckInput.svelte";
  import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
  import TextInput from "src/lib/UI/GUI/TextInput.svelte";
  import { alertConfirm, alertSelect } from "src/ts/alert";
  import { getCharImage } from "src/ts/characters";
  import {
    changeUserPersona,
    exportUserPersona,
    importUserPersona,
    saveUserPersona,
    selectUserImg,
  } from "src/ts/persona";
  import Sortable from "sortablejs/modular/sortable.core.esm.js";
  import { onDestroy, onMount } from "svelte";
  import { sleep, sortableOptions } from "src/ts/util";
  import { DBState } from "src/ts/stores.svelte";
  import { v4 } from "uuid";
  import {
    entityRuntimeEnabled,
    browserRuntime,
    reportRuntimeError,
  } from "src/ts/runtime/browserRuntimeState.svelte";
  import {
    getSettingDatabase,
    setSettingValues,
  } from "src/ts/runtime/fieldControls";
  import { getFieldValue } from "src/ts/runtime/fieldControls";
  let settings = $derived(getSettingDatabase(DBState.db));
  const field = (key: string, value: any) =>
    setSettingValues(DBState.db, new Map([[key, value]]));
  const portraitTarget = () => ({
    scope: "resource" as const,
    resourceKind: "persona" as const,
    entityId: DBState.db.personas[DBState.db.selectedPersona]?.id,
    key: "largePortrait",
  });
  const portrait = () =>
    getFieldValue(
      portraitTarget(),
      DBState.db.personas[DBState.db.selectedPersona]?.largePortrait ?? false,
    );
  const setPortrait = (value: boolean) => {
    if (entityRuntimeEnabled)
      browserRuntime().setField(portraitTarget(), value);
    else DBState.db.personas[DBState.db.selectedPersona].largePortrait = value;
  };

  let stb: Sortable = null;
  let ele: HTMLDivElement = $state();
  let sorted = $state(0);
  let selectedId: string = null;
  let orderGuard = { revision: 0, epoch: 0 };
  const createStb = () => {
    stb = Sortable.create(ele, {
      onStart: async () => {
        if (entityRuntimeEnabled) {
          orderGuard = browserRuntime().libraryOrderHeader("persona");
          return;
        }
        DBState.db.personas[DBState.db.selectedPersona].id ??= v4();
        selectedId = DBState.db.personas[DBState.db.selectedPersona].id;
        saveUserPersona();
      },
      onEnd: async () => {
        let idx: number[] = [];
        ele.querySelectorAll("[data-risu-idx]").forEach((e, i) => {
          idx.push(parseInt(e.getAttribute("data-risu-idx")));
        });
        let newValue: {
          personaPrompt: string;
          name: string;
          icon: string;
          note?: string;
          largePortrait?: boolean;
          id?: string;
        }[] = [];
        idx.forEach((i) => {
          newValue.push(DBState.db.personas[i]);
        });
        if (entityRuntimeEnabled) {
          try {
            await browserRuntime().reorderLibrary(
              "persona",
              newValue.map((value) => value.id),
              orderGuard,
            );
          } catch (error) {
            reportRuntimeError(error);
          }
          stb.destroy();
          sorted += 1;
          await sleep(1);
          createStb();
          return;
        }
        DBState.db.personas = newValue;
        const selectedPersona = DBState.db.personas.findIndex(
          (e) => e.id === selectedId,
        );
        changeUserPersona(
          selectedPersona !== -1 ? selectedPersona : 0,
          "noSave",
        );
        try {
          stb.destroy();
        } catch (error) {}
        sorted += 1;
        await sleep(1);
        createStb();
      },
      ...sortableOptions,
    });
  };

  onMount(createStb);

  onDestroy(() => {
    if (stb) {
      try {
        stb.destroy();
      } catch (error) {}
    }
  });
</script>

<h2 class="mb-2 text-2xl font-bold mt-2">{language.persona}</h2>

{#key sorted}
  <div
    class="p-4 rounded-md border-darkborderc border mb-2 flex-wrap flex gap-2 w-full max-w-full min-w-0"
    bind:this={ele}
  >
    {#each DBState.db.personas as persona, i (entityRuntimeEnabled ? persona.id : i)}
      <button
        data-persona-id={persona.id}
        data-risu-idx={i}
        onclick={() => {
          changeUserPersona(i);
        }}
      >
        {#if persona.icon === ""}
          <div
            class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500"
            class:ring-3={i === DBState.db.selectedPersona}
          ></div>
        {:else}
          {#await getCharImage(persona.icon, "css")}
            <div
              class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500"
              class:ring-3={i === DBState.db.selectedPersona}
            ></div>
          {:then im}
            <div
              class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500"
              style={im}
              class:ring-3={i === DBState.db.selectedPersona}
            ></div>
          {/await}
        {/if}
      </button>
    {/each}
    <div
      data-runtime-persona-action="create"
      class="flex justify-center items-center ml-2 mr-2"
    >
      <BaseRoundedButton
        onClick={async () => {
          const sel = parseInt(
            await alertSelect([
              language.createfromScratch,
              language.importCharacter,
            ]),
          );
          if (sel === 0) {
            const persona = {
              id: v4(),
              name: "New Persona",
              icon: "",
              personaPrompt: "",
              note: "",
            };
            if (entityRuntimeEnabled) {
              try {
                const id = await browserRuntime().saveLibraryResource(
                  "persona",
                  persona,
                );
                await browserRuntime().activateLibrary("persona", id);
              } catch (error) {
                reportRuntimeError(error);
              }
              return;
            }
            DBState.db.personas.push(persona);
            changeUserPersona(DBState.db.personas.length - 1);
          } else if (sel === 1) {
            await importUserPersona();
          }
        }}
        ><svg viewBox="0 0 24 24" width="1.2em" height="1.2em"
          ><path
            fill="none"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M12 6v6m0 0v6m0-6h6m-6 0H6"
          /></svg
        >
      </BaseRoundedButton>
    </div>
  </div>
{/key}

<div
  class="flex w-full items-starts rounded-md border-darkborderc border p-4 max-w-full flex-wrap"
>
  <div class="flex flex-col mt-4 mr-4">
    <button
      onclick={() => {
        void selectUserImg().catch(reportRuntimeError);
      }}
    >
      {#if DBState.db.userIcon === ""}
        <div
          class="rounded-md h-28 w-28 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500"
        ></div>
      {:else}
        {#await getCharImage(DBState.db.userIcon, DBState.db.personas[DBState.db.selectedPersona].largePortrait ? "lgcss" : "css")}
          <div
            class="rounded-md h-28 w-28 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500"
          ></div>
        {:then im}
          <div
            class="rounded-md h-28 w-28 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500"
            style={im}
          ></div>
        {/await}
      {/if}
    </button>
  </div>
  <div class="flex grow flex-col p-2 max-w-full">
    <span class="text-sm text-textcolor2">{language.name}</span>
    <TextInput
      marginBottom
      size="lg"
      placeholder="User"
      id="runtime-persona-name"
      bind:value={() => settings.username, (value) => field("username", value)}
    />
    <span class="text-sm text-textcolor2">{language.note}</span>
    {#if DBState.db.personaNote}
      <TextInput
        marginBottom
        size="lg"
        id="runtime-persona-note"
        bind:value={
          () => settings.userNote, (value) => field("userNote", value)
        }
        placeholder={`Put a unique identifier for this persona here.\nExample: [Alternate Hunters persona]`}
      />
    {/if}
    <span class="text-sm text-textcolor2">{language.description}</span>
    <TextAreaInput
      autocomplete="off"
      id="runtime-persona-description"
      bind:value={
        () => settings.personaPrompt, (value) => field("personaPrompt", value)
      }
      placeholder={`Put the description of this persona here.\nExample: [<user> is a 20 year old girl.]`}
    />
    <div class="flex gap-2 mt-4 max-w-full flex-wrap">
      <Button onclick={() => exportUserPersona().catch(reportRuntimeError)}
        >{language.export}</Button
      >
      <Button onclick={() => importUserPersona().catch(reportRuntimeError)}
        >{language.import}</Button
      >

      <div data-runtime-persona-action="delete">
        <Button
          styled="danger"
          onclick={async () => {
            if (DBState.db.personas.length === 1) {
              return;
            }
            const persona = DBState.db.personas[DBState.db.selectedPersona];
            const header = entityRuntimeEnabled
              ? browserRuntime().libraryHeader("persona", persona.id)
              : undefined;
            const d = await alertConfirm(
              `${language.removeConfirm}${persona.name}`,
            );
            if (d) {
              if (entityRuntimeEnabled) {
                try {
                  await browserRuntime().deleteLibraryResource(
                    "persona",
                    persona.id,
                    header,
                  );
                } catch (error) {
                  reportRuntimeError(error);
                }
                return;
              }
              saveUserPersona();
              let personas = DBState.db.personas;
              personas.splice(DBState.db.selectedPersona, 1);
              DBState.db.personas = personas;
              changeUserPersona(0, "noSave");
            }
          }}>{language.remove}</Button
        >
      </div>
      <div data-runtime-persona-action="portrait">
        <Check bind:check={portrait, setPortrait}
          >{language.largePortrait}</Check
        >
      </div>
    </div>
  </div>
</div>
