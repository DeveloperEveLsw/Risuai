<script lang="ts">
  import { language } from "../../lang";
  import { DBState } from "src/ts/stores.svelte";
  import type { character } from "src/ts/storage/database.svelte";
  import { PlusIcon, TrashIcon, ArrowUp, ArrowDown } from "@lucide/svelte";
  import Help from "../Others/Help.svelte";
  import TextInput from "../UI/GUI/TextInput.svelte";
  import NumberInput from "../UI/GUI/NumberInput.svelte";
  import TextAreaInput from "../UI/GUI/TextAreaInput.svelte";
  import MultiLangInput from "../UI/GUI/MultiLangInput.svelte";
  import Check from "../UI/GUI/CheckInput.svelte";
  type DefinitionSettings = Pick<
    character,
    | "bias"
    | "exampleMessage"
    | "creatorNotes"
    | "removedQuotes"
    | "systemPrompt"
    | "replaceGlobalNote"
    | "additionalText"
    | "personality"
    | "scenario"
    | "defaultVariables"
    | "translatorNote"
    | "customModuleToggle"
    | "additionalData"
    | "nickname"
    | "depth_prompt"
    | "alternateGreetings"
    | "lowLevelAccess"
    | "hideChatIcon"
    | "utilityBot"
    | "escapeOutput"
  >;
  let {
    values,
    onRemoveGreeting,
    normalizeNotesOnMount = true,
  }: {
    values: DefinitionSettings;
    onRemoveGreeting: () => void;
    normalizeNotesOnMount?: boolean;
  } = $props();
  function moveAlternateGreetingUp(index: number) {
    if (index === 0) return;
    const greetings = values.alternateGreetings ?? [];
    [greetings[index], greetings[index - 1]] = [
      greetings[index - 1],
      greetings[index],
    ];
  }
  function moveAlternateGreetingDown(index: number) {
    const greetings = values.alternateGreetings ?? [];
    if (index === greetings.length - 1) return;
    [greetings[index], greetings[index + 1]] = [
      greetings[index + 1],
      greetings[index],
    ];
  }
</script>

<div class="contents" data-character-definition-settings>
  <div class="contents" data-definition-bias>
    <span class="text-textcolor mt-2">Bias <Help key="bias" /></span>
    <div class="w-full max-w-full border border-selected rounded-md p-2 mb-2">
      <table class="w-full max-w-full tabler mt-2">
        <tbody>
          <tr>
            <th class="font-medium w-1/2">Bias</th>
            <th class="font-medium w-1/3">{language.value}</th>
            <th>
              <button
                class="font-medium cursor-pointer hover:text-green-500"
                onclick={() => {
                  (values.bias ??= []).push(["", 0]);
                }}><PlusIcon /></button
              >
            </th>
          </tr>
          {#if !values.bias?.length}
            <tr>
              <td colspan="3">{language.noBias}</td>
            </tr>
          {/if}
          {#each values.bias ?? [] as bias, i}
            <tr class="align-middle text-center">
              <td class="font-medium truncate w-1/2">
                <TextInput
                  fullh
                  fullwidth
                  bind:value={values.bias[i][0]}
                  placeholder="string"
                />
              </td>
              <td class="font-medium truncate w-1/3">
                <NumberInput
                  fullh
                  fullwidth
                  bind:value={values.bias[i][1]}
                  max={100}
                  min={-100}
                />
              </td>
              <td>
                <button
                  class="font-medium flex justify-center items-center w-full h-full cursor-pointer hover:text-green-500"
                  onclick={() => {
                    values.bias.splice(i, 1);
                  }}><TrashIcon /></button
                >
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
  <span class="text-textcolor"
    >{language.exampleMessage} <Help key="exampleMessage" /></span
  >
  <TextAreaInput
    highlight
    margin="both"
    autocomplete="off"
    id="runtime-definition-exampleMessage"
    bind:value={
      () => values.exampleMessage ?? "",
      (value) => {
        if (value !== (values.exampleMessage ?? ""))
          values.exampleMessage = value;
      }
    }
  ></TextAreaInput>

  <span class="text-textcolor"
    >{language.creatorNotes} <Help key="creatorQuotes" /></span
  >
  <MultiLangInput
    id="runtime-definition-creatorNotes"
    bind:value={
      () => values.creatorNotes ?? "",
      (value) => {
        if (value !== (values.creatorNotes ?? "")) values.creatorNotes = value;
      }
    }
    normalizeOnMount={normalizeNotesOnMount}
    className="my-2"
    onInput={() => {
      values.removedQuotes = false;
    }}
  ></MultiLangInput>

  <span class="text-textcolor"
    >{language.systemPrompt} <Help key="systemPrompt" /></span
  >
  <TextAreaInput
    highlight
    margin="both"
    autocomplete="off"
    id="runtime-definition-systemPrompt"
    bind:value={
      () => values.systemPrompt ?? "",
      (value) => {
        if (value !== (values.systemPrompt ?? "")) values.systemPrompt = value;
      }
    }
  ></TextAreaInput>

  <span class="text-textcolor"
    >{language.replaceGlobalNote} <Help key="replaceGlobalNote" /></span
  >
  <TextAreaInput
    highlight
    margin="both"
    autocomplete="off"
    id="runtime-definition-replaceGlobalNote"
    bind:value={
      () => values.replaceGlobalNote ?? "",
      (value) => {
        if (value !== (values.replaceGlobalNote ?? ""))
          values.replaceGlobalNote = value;
      }
    }
  ></TextAreaInput>

  <span class="text-textcolor mt-2"
    >{language.additionalText} <Help key="additionalText" /></span
  >
  <TextAreaInput
    highlight
    margin="both"
    autocomplete="off"
    id="runtime-definition-additionalText"
    bind:value={
      () => values.additionalText ?? "",
      (value) => {
        if (value !== (values.additionalText ?? ""))
          values.additionalText = value;
      }
    }
  ></TextAreaInput>

  {#if DBState.db.showUnrecommended || (values.personality?.length ?? 0) > 3}
    <span class="text-textcolor"
      >{language.personality} <Help key="personality" unrecommended /></span
    >
    <TextAreaInput
      highlight
      margin="both"
      autocomplete="off"
      id="runtime-definition-personality"
      bind:value={
        () => values.personality ?? "",
        (value) => {
          if (value !== (values.personality ?? "")) values.personality = value;
        }
      }
    ></TextAreaInput>
  {/if}
  {#if DBState.db.showUnrecommended || (values.scenario?.length ?? 0) > 3}
    <span class="text-textcolor"
      >{language.scenario} <Help key="scenario" unrecommended /></span
    >
    <TextAreaInput
      highlight
      margin="both"
      autocomplete="off"
      id="runtime-definition-scenario"
      bind:value={
        () => values.scenario ?? "",
        (value) => {
          if (value !== (values.scenario ?? "")) values.scenario = value;
        }
      }
    ></TextAreaInput>
  {/if}

  <span class="text-textcolor mt-2"
    >{language.defaultVariables} <Help key="defaultVariables" /></span
  >
  <TextAreaInput
    margin="both"
    autocomplete="off"
    id="runtime-definition-defaultVariables"
    bind:value={
      () => values.defaultVariables ?? "",
      (value) => {
        if (value !== (values.defaultVariables ?? ""))
          values.defaultVariables = value;
      }
    }
  ></TextAreaInput>

  <span class="text-textcolor mt-2"
    >{language.translatorNote} <Help key="translatorNote" /></span
  >
  <TextAreaInput
    margin="both"
    autocomplete="off"
    id="runtime-definition-translatorNote"
    bind:value={
      () => values.translatorNote ?? "",
      (value) => {
        if (value !== (values.translatorNote ?? ""))
          values.translatorNote = value;
      }
    }
  ></TextAreaInput>

  <span class="text-textcolor mt-2"
    >{language.customPromptTemplateToggle}
    <Help key="customPromptTemplateToggle" /></span
  >
  <TextAreaInput
    margin="both"
    autocomplete="off"
    id="runtime-definition-customModuleToggle"
    bind:value={
      () => values.customModuleToggle ?? "",
      (value) => {
        if (value !== (values.customModuleToggle ?? ""))
          values.customModuleToggle = value;
      }
    }
  ></TextAreaInput>

  <span class="text-textcolor">{language.creator}</span>
  <TextInput
    size="sm"
    autocomplete="off"
    id="runtime-definition-creator"
    bind:value={
      () => values.additionalData?.creator ?? "",
      (value) => {
        if (value !== (values.additionalData?.creator ?? ""))
          values.additionalData = { ...values.additionalData, creator: value };
      }
    }
  />

  <span class="text-textcolor">{language.CharVersion}</span>
  <TextInput
    size="sm"
    id="runtime-definition-version"
    bind:value={
      () => values.additionalData?.character_version ?? "",
      (value) => {
        if (value !== (values.additionalData?.character_version ?? ""))
          values.additionalData = {
            ...values.additionalData,
            character_version: value,
          };
      }
    }
  />

  <span class="text-textcolor">{language.nickname} <Help key="nickname" /></span
  >
  <TextInput
    size="sm"
    id="runtime-definition-nickname"
    bind:value={
      () => values.nickname ?? "",
      (value) => {
        if (value !== (values.nickname ?? "")) values.nickname = value;
      }
    }
  />

  <span class="text-textcolor">{language.depthPrompt}</span>
  <div class="flex justify-center items-center">
    <NumberInput
      size="sm"
      id="runtime-definition-depth"
      bind:value={
        () => values.depth_prompt?.depth ?? 0,
        (value) => {
          if (value !== (values.depth_prompt?.depth ?? 0))
            values.depth_prompt = {
              ...values.depth_prompt,
              depth: value,
              prompt: values.depth_prompt?.prompt ?? "",
            };
        }
      }
      className="w-12"
    />
    <TextInput
      size="sm"
      id="runtime-definition-depth-prompt"
      bind:value={
        () => values.depth_prompt?.prompt ?? "",
        (value) => {
          if (value !== (values.depth_prompt?.prompt ?? ""))
            values.depth_prompt = {
              ...values.depth_prompt,
              depth: values.depth_prompt?.depth ?? 0,
              prompt: value,
            };
        }
      }
      className="flex-1"
    />
  </div>

  <div class="contents" data-definition-greetings>
    <span class="text-textcolor mt-2">{language.altGreet}</span>
    <div class="w-full max-w-full border border-selected rounded-md p-2">
      <table class="contain w-full max-w-full tabler mt-2">
        <tbody>
          <tr>
            <th class="font-medium">{language.value}</th>
            <th class="font-medium cursor-pointer w-8">
              <button
                class="hover:text-green-500"
                onclick={() => {
                  let alternateGreetings = values.alternateGreetings ?? [];
                  alternateGreetings.push("");
                  values.alternateGreetings = alternateGreetings;
                }}
              >
                <PlusIcon />
              </button>
            </th>
          </tr>
          {#if !values.alternateGreetings?.length}
            <tr>
              <td colspan="3">{language.noData}</td>
            </tr>
          {/if}
          {#each values.alternateGreetings ?? [] as bias, i}
            <tr>
              <td class="font-medium truncate">
                <TextAreaInput
                  highlight
                  bind:value={values.alternateGreetings[i]}
                  placeholder="..."
                  fullwidth
                />
              </td>
              <th class="font-medium cursor-pointer w-8">
                <div class="flex flex-col items-center">
                  <button
                    class="hover:text-blue-500 p-1"
                    data-greeting-action="up"
                    onclick={() => moveAlternateGreetingUp(i)}
                    disabled={i === 0}
                  >
                    <ArrowUp size={16} />
                  </button>
                  <button
                    class="hover:text-blue-500 p-1"
                    data-greeting-action="down"
                    onclick={() => moveAlternateGreetingDown(i)}
                    disabled={i === values.alternateGreetings.length - 1}
                  >
                    <ArrowDown size={16} />
                  </button>
                  <button
                    class="hover:text-red-500 p-1"
                    data-greeting-action="remove"
                    onclick={() => {
                      onRemoveGreeting();
                      let alternateGreetings = values.alternateGreetings;
                      alternateGreetings.splice(i, 1);
                      values.alternateGreetings = alternateGreetings;
                    }}
                  >
                    <TrashIcon size={16} />
                  </button>
                </div>
              </th>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
  <div class="flex items-center mt-4">
    <Check
      bind:check={
        () => values.lowLevelAccess ?? false,
        (value) => {
          if (value !== (values.lowLevelAccess ?? false))
            values.lowLevelAccess = value;
        }
      }
      name={language.lowLevelAccess}
    />
    <span> <Help key="lowLevelAccess" name={language.lowLevelAccess} /></span>
  </div>

  <div class="flex items-center mt-4">
    <Check
      bind:check={
        () => values.hideChatIcon ?? false,
        (value) => {
          if (value !== (values.hideChatIcon ?? false))
            values.hideChatIcon = value;
        }
      }
      name={language.hideChatIcon}
    />
  </div>

  <div class="flex items-center mt-4">
    <Check
      bind:check={
        () => values.utilityBot ?? false,
        (value) => {
          if (value !== (values.utilityBot ?? false)) values.utilityBot = value;
        }
      }
      name={language.utilityBot}
    />
    <span> <Help key="utilityBot" name={language.utilityBot} /></span>
  </div>

  <div class="flex items-center mt-4">
    <Check
      bind:check={
        () => values.escapeOutput ?? false,
        (value) => {
          if (value !== (values.escapeOutput ?? false))
            values.escapeOutput = value;
        }
      }
      name={language.escapeOutput}
    />
  </div>
</div>

<style>
  .tabler {
    table-layout: fixed;
  }
  .tabler td {
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
