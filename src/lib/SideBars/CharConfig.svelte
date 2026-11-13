<script lang="ts">
  import ChatMemoryText from "./ChatMemoryText.svelte";
  import { getFieldValue, setFieldValue } from "src/ts/runtime/fieldControls";
  import CharacterDefinitionSettings from "./CharacterDefinitionSettings.svelte";
  import CharacterTtsSettings from "./CharacterTtsSettings.svelte";
  import CharacterAssetSettings from "./CharacterAssetSettings.svelte";
  import { characterAssetFields } from "src/ts/runtime/characterAssetControls";
  import { characterTtsFields } from "src/ts/runtime/characterTtsControls";
  import { characterModuleSource } from "src/ts/runtime/characterModuleActions";
  import RuntimeObjectFields from "src/lib/Setting/Wrappers/RuntimeObjectFields.svelte";
  const definitionFields = [
    "bias",
    "exampleMessage",
    "creatorNotes",
    "removedQuotes",
    "systemPrompt",
    "replaceGlobalNote",
    "additionalText",
    "personality",
    "scenario",
    "defaultVariables",
    "translatorNote",
    "customModuleToggle",
    "additionalData",
    "nickname",
    "depth_prompt",
    "alternateGreetings",
    "lowLevelAccess",
    "hideChatIcon",
    "utilityBot",
    "escapeOutput",
  ] as const;
  import RuntimeObjectField from "src/lib/Setting/Wrappers/RuntimeObjectField.svelte";
  import {
    browserRuntime,
    entityRuntimeEnabled,
    reportRuntimeError,
  } from "src/ts/runtime/browserRuntimeState.svelte";
  const groupView = () => {
    const group = DBState.db.characters[$selectedCharID] as groupChat;
    return entityRuntimeEnabled
      ? browserRuntime().groupView(group.chaId)
      : group;
  };
  const groupPending = (memberId?: string) =>
    entityRuntimeEnabled &&
    browserRuntime().groupPending(
      DBState.db.characters[$selectedCharID].chaId,
      memberId,
    );
  function writeGroupMember(
    memberId: string,
    position: number,
    action: "set-active" | "set-talkness",
    value: boolean | number,
  ) {
    const key = action === "set-active" ? "characterActive" : "characterTalks";
    if (groupView()[key][position] === value) return;
    if (entityRuntimeEnabled) {
      try {
        const runtime = browserRuntime();
        const target = runtime.captureGroupMember(
          DBState.db.characters[$selectedCharID].chaId,
          memberId,
          position,
        );
        void runtime
          .changeGroupMember(target, action, value)
          .catch(reportRuntimeError);
      } catch (error) {
        reportRuntimeError(error);
      }
    } else {
      (DBState.db.characters[$selectedCharID] as groupChat)[key][position] =
        value as never;
    }
  }
  import type { Json } from "src/ts/runtime/clientProtocol";
  import { commandJson } from "src/ts/runtime/clientProtocol";
  const characterTarget = (key: string) => ({
    scope: "character" as const,
    entityId: DBState.db.characters[$selectedCharID].chaId,
    key,
  });
  const currentField = (key: string) =>
    getFieldValue(
      characterTarget(key),
      (DBState.db.characters[$selectedCharID] as any)[key],
    );
  function writeField(key: string, value: Json) {
    const current = currentField(key);
    if (
      current === value ||
      (current !== undefined && commandJson(current) === commandJson(value))
    )
      return;
    setFieldValue(characterTarget(key), value, () => {
      (DBState.db.characters[$selectedCharID] as any)[key] = value;
    });
  }
  const currentChat = () => {
    const c = DBState.db.characters[$selectedCharID];
    return c.chats[c.chatPage];
  };
  const noteTarget = () => ({
    scope: "chat" as const,
    entityId: currentChat().id,
    key: "note",
  });
  import { language } from "../../lang";
  import { tokenizeAccurate } from "../../ts/tokenizer";
  import {
    getCurrentCharacter,
    saveImage as saveAsset,
    type character,
    type groupChat,
  } from "../../ts/storage/database.svelte";
  import { DBState } from "src/ts/stores.svelte";
  import { untrack } from "svelte";
  import {
    CharConfigSubMenu,
    MobileGUI,
    ShowRealmFrameStore,
    selectedCharID,
    hypaV3ModalOpen,
  } from "../../ts/stores.svelte";
  import {
    PlusIcon,
    SmileIcon,
    TrashIcon,
    UserIcon,
    ActivityIcon,
    BookIcon,
    User,
    Braces,
    Volume2Icon,
    DownloadIcon,
    HardDriveUploadIcon,
    Share2Icon,
    ImageIcon,
    ImageOffIcon,
  } from "@lucide/svelte";
  import Check from "../UI/GUI/CheckInput.svelte";
  import {
    addCharEmotion,
    addingEmotion,
    getCharImage,
    rmCharEmotion,
    selectCharImg,
    makeGroupImage,
    removeChar,
    changeCharImage,
  } from "../../ts/characters";
  import LoreBook from "./LoreBook/LoreBookSetting.svelte";
  import { alertNormal, alertTOS, showHypaV2Alert } from "../../ts/alert";
  import BarIcon from "./BarIcon.svelte";
  import {
    findCharacterbyId,
    getAuthorNoteDefaultText,
    selectMultipleFile,
    selectSingleFile,
  } from "../../ts/util";
  import Help from "../Others/Help.svelte";
  import { exportChar } from "src/ts/characterCards";
  import { getFileSrc } from "src/ts/globalApi.svelte";
  import { addGroupChar, rmCharFromGroup } from "src/ts/process/group";
  import TextInput from "../UI/GUI/TextInput.svelte";
  import NumberInput from "../UI/GUI/NumberInput.svelte";
  import TextAreaInput from "../UI/GUI/TextAreaInput.svelte";
  import Button from "../UI/GUI/Button.svelte";
  import SelectInput from "../UI/GUI/SelectInput.svelte";
  import OptionInput from "../UI/GUI/OptionInput.svelte";
  import RegexList from "./Scripts/RegexList.svelte";
  import TriggerList from "./Scripts/TriggerList.svelte";
  import CheckInput from "../UI/GUI/CheckInput.svelte";
  import { updateInlayScreen } from "src/ts/process/inlayScreen";
  import { applyModule } from "src/ts/process/modules";
  import { exportRegex, importRegex } from "src/ts/process/scripts";
  import SliderInput from "../UI/GUI/SliderInput.svelte";
  import Toggles from "./Toggles.svelte";
  import { convertCharacterToModule } from "src/ts/interchangeability";

  let iconRemoveMode = $state(false);
  let convertingModule = $state(false);
  let viewSubMenu = $state(0);
  let emos: [string, string][] = $state([]);
  let iconButtonSize = window.innerWidth > 360 ? (24 as const) : (20 as const);
  let tokens = $state({
    desc: 0,
    firstMsg: 0,
    localNote: 0,
    charaNote: 0,
  });

  let lasttokens = {
    desc: "",
    firstMsg: "",
    localNote: "",
    charaNote: "",
  };

  async function loadTokenize(
    desc: string | null,
    firstMsg: string | null,
    localNote: string,
  ) {
    if (desc !== null && lasttokens.desc !== desc) {
      lasttokens.desc = desc;
      tokens.desc = await tokenizeAccurate(desc);
    }
    if (firstMsg !== null && lasttokens.firstMsg !== firstMsg) {
      lasttokens.firstMsg = firstMsg;
      tokens.firstMsg = await tokenizeAccurate(firstMsg);
    }
    if (lasttokens.localNote !== localNote) {
      lasttokens.localNote = localNote;
      tokens.localNote = await tokenizeAccurate(localNote);
    }
  }

  let assetFileExtensions: string[] = $state([]);
  let assetFilePath: string[] = $state([]);
  let licensed = $state(
    DBState.db.characters[$selectedCharID].type === "character"
      ? (DBState.db.characters[$selectedCharID] as character).license
      : "",
  );

  $effect.pre(() => {
    emos = DBState.db.characters[$selectedCharID].emotionImages;
  });

  $effect.pre(() => {
    const chara = DBState.db.characters[$selectedCharID];
    const desc = chara.type !== "group" ? (chara as character).desc : null;
    const firstMsg = chara.type !== "group" ? chara.firstMessage : null;
    const localNote = chara.chats[chara.chatPage].note;

    untrack(() => {
      loadTokenize(desc, firstMsg, localNote);
    });
  });

  $effect.pre(() => {
    if (
      !entityRuntimeEnabled &&
      DBState.db.characters[$selectedCharID].type === "character" &&
      DBState.db.useAdditionalAssetsPreview
    ) {
      if (
        (DBState.db.characters[$selectedCharID] as character).additionalAssets
      ) {
        for (
          let i = 0;
          i <
          (DBState.db.characters[$selectedCharID] as character).additionalAssets
            .length;
          i++
        ) {
          if (
            (DBState.db.characters[$selectedCharID] as character)
              .additionalAssets[i].length > 2 &&
            (DBState.db.characters[$selectedCharID] as character)
              .additionalAssets[i][2]
          ) {
            assetFileExtensions[i] = (
              DBState.db.characters[$selectedCharID] as character
            ).additionalAssets[i][2];
          } else
            assetFileExtensions[i] = (
              DBState.db.characters[$selectedCharID] as character
            ).additionalAssets[i][1]
              .split(".")
              .pop();
          getFileSrc(
            (DBState.db.characters[$selectedCharID] as character)
              .additionalAssets[i][1],
          ).then((filePath) => {
            assetFilePath[i] = filePath;
          });
        }
      }
    }
  });

  $effect.pre(() => {
    licensed =
      DBState.db.characters[$selectedCharID].type === "character"
        ? (DBState.db.characters[$selectedCharID] as character).license
        : "";
  });
  $effect.pre(() => {
    if (
      !entityRuntimeEnabled &&
      DBState.db.characters[$selectedCharID].ttsMode === "novelai" &&
      (DBState.db.characters[$selectedCharID] as character).naittsConfig ===
        undefined
    ) {
      (DBState.db.characters[$selectedCharID] as character).naittsConfig = {
        customvoice: false,
        voice: "Aini",
        version: "v2",
      };
    }
  });
  $effect.pre(() => {
    if (
      !entityRuntimeEnabled &&
      DBState.db.characters[$selectedCharID].ttsMode === "gptsovits" &&
      (DBState.db.characters[$selectedCharID] as character).gptSoVitsConfig ===
        undefined
    ) {
      (DBState.db.characters[$selectedCharID] as character).gptSoVitsConfig = {
        url: "",
        use_auto_path: false,
        ref_audio_path: "",
        use_long_audio: false,
        ref_audio_data: {
          fileName: "",
          assetId: "",
        },
        volume: 1.0,
        text_lang: "auto",
        text: "en",
        use_prompt: false,
        prompt_lang: "en",
        top_p: 1,
        temperature: 0.7,
        speed: 1,
        top_k: 5,
        text_split_method: "cut0",
      };
    }
  });

  $effect.pre(() => {
    if (
      !entityRuntimeEnabled &&
      DBState.db.characters[$selectedCharID].ttsMode === "fishspeech" &&
      (DBState.db.characters[$selectedCharID] as character).fishSpeechConfig ===
        undefined
    ) {
      (DBState.db.characters[$selectedCharID] as character).fishSpeechConfig = {
        model: {
          _id: "",
          title: "",
          description: "",
        },
        chunk_length: 200,
        normalize: false,
      };
    }
  });

  $effect.pre(() => {
    if (
      !entityRuntimeEnabled &&
      DBState.db.characters[$selectedCharID].ttsMode === "openai" &&
      (DBState.db.characters[$selectedCharID] as character).oaiTTSConfig ===
        undefined
    ) {
      (DBState.db.characters[$selectedCharID] as character).oaiTTSConfig = {
        enabled: false,
        format: "mp3",
      };
    }
  });

  $effect.pre(() => {
    if (
      DBState.db.characters[$selectedCharID].type === "group" &&
      ($CharConfigSubMenu === 4 || $CharConfigSubMenu === 5)
    ) {
      $CharConfigSubMenu = 0;
    }
  });
</script>

{#if licensed !== "private" && !$MobileGUI}
  <div
    class="flex mb-2"
    class:gap-2={iconButtonSize === 24}
    class:gap-1={iconButtonSize < 24}
  >
    <button
      class={$CharConfigSubMenu === 0 ? "text-textcolor " : "text-textcolor2"}
      onclick={() => {
        $CharConfigSubMenu = 0;
      }}
    >
      <UserIcon size={iconButtonSize} />
    </button>
    <button
      aria-label={language.characterDisplay}
      class={$CharConfigSubMenu === 1 ? "text-textcolor" : "text-textcolor2"}
      onclick={() => {
        $CharConfigSubMenu = 1;
      }}
    >
      <SmileIcon size={iconButtonSize} />
    </button>
    <button
      class={$CharConfigSubMenu === 3 ? "text-textcolor" : "text-textcolor2"}
      onclick={() => {
        $CharConfigSubMenu = 3;
      }}
    >
      <BookIcon size={iconButtonSize} />
    </button>
    {#if DBState.db.characters[$selectedCharID].type === "character"}
      <button
        class={$CharConfigSubMenu === 5 ? "text-textcolor" : "text-textcolor2"}
        onclick={() => {
          $CharConfigSubMenu = 5;
        }}
      >
        <Volume2Icon size={iconButtonSize} />
      </button>
      <button
        class={$CharConfigSubMenu === 4 ? "text-textcolor" : "text-textcolor2"}
        onclick={() => {
          $CharConfigSubMenu = 4;
        }}
      >
        <Braces size={iconButtonSize} />
      </button>
    {/if}
    <button
      class={$CharConfigSubMenu === 2 ? "text-textcolor" : "text-textcolor2"}
      onclick={() => {
        $CharConfigSubMenu = 2;
      }}
    >
      <ActivityIcon size={iconButtonSize} />
    </button>
    {#if DBState.db.characters[$selectedCharID].type === "character"}
      <button
        class={$CharConfigSubMenu === 6 ? "text-textcolor" : "text-textcolor2"}
        onclick={() => {
          $CharConfigSubMenu = 6;
        }}
      >
        <Share2Icon size={iconButtonSize} />
      </button>
    {/if}
  </div>
{/if}

{#if $CharConfigSubMenu === 0}
  {#if DBState.db.characters[$selectedCharID].type !== "group" && licensed !== "private"}
    <TextInput
      size="xl"
      marginBottom
      id="runtime-character-name"
      placeholder="Character Name"
      bind:value={
        () => currentField("name"), (value) => writeField("name", value)
      }
    />
    <span class="text-textcolor"
      >{language.description} <Help key="charDesc" /></span
    >
    <TextAreaInput
      highlight
      margin="both"
      autocomplete="off"
      id="runtime-character-description"
      bind:value={
        () => currentField("desc"), (value) => writeField("desc", value)
      }
    ></TextAreaInput>
    <span class="text-textcolor2 mb-6 text-sm"
      >{tokens.desc} {language.tokens}</span
    >
    <span class="text-textcolor"
      >{language.firstMessage} <Help key="charFirstMessage" /></span
    >
    <TextAreaInput
      highlight
      margin="both"
      autocomplete="off"
      id="runtime-character-greeting"
      bind:value={
        () => currentField("firstMessage"),
        (value) => writeField("firstMessage", value)
      }
    ></TextAreaInput>
    <span class="text-textcolor2 mb-6 text-sm"
      >{tokens.firstMsg} {language.tokens}</span
    >
  {:else if licensed !== "private" && DBState.db.characters[$selectedCharID].type === "group"}
    <TextInput
      size="xl"
      marginBottom
      id="runtime-character-name"
      placeholder="Group Name"
      bind:value={
        () => currentField("name"), (value) => writeField("name", value)
      }
    />
    <span class="text-textcolor">{language.character}</span>
    <div class="p-4 gap-2 bg-bgcolor rounded-lg char-grid">
      {#if groupView().characters.length === 0}
        <span class="text-textcolor2">No Character</span>
      {:else}
        <div></div>
        <div class="text-center">{language.talkness}</div>
        <div class="text-center">{language.active}</div>
        {#each groupView().characters as char, i (`${char}:${groupView()
            .characters.slice(0, i)
            .filter((id) => id === char).length}`)}
          <div data-group-remove={char} aria-busy={groupPending(char)}>
            {#await getCharImage(findCharacterbyId(char).image, "css")}
              <BarIcon
                disabled={groupPending(char)}
                ariaLabel={`${language.remove} ${findCharacterbyId(char).name}`}
                onClick={() => {
                  rmCharFromGroup(i);
                }}
              >
                <User />
              </BarIcon>
            {:then im}
              <BarIcon
                disabled={groupPending(char)}
                ariaLabel={`${language.remove} ${findCharacterbyId(char).name}`}
                onClick={() => {
                  rmCharFromGroup(i);
                }}
                additionalStyle={im}
              />
            {/await}
          </div>
          <div class="flex items-center px-2 py-3">
            {#each [1, 2, 3, 4, 5, 6] as barIndex}
              <button
                class="bg-selected h-full flex-1 border-r-bgcolor border-r"
                aria-label={`${language.talkness} ${barIndex}/6`}
                data-group-talkness={char}
                data-talkness-step={barIndex}
                disabled={groupPending(char)}
                aria-pressed={groupView().characterTalks[i] >=
                  (1 / 6) * barIndex}
                class:bg-green-500={groupView().characterTalks[i] >=
                  (1 / 6) * barIndex}
                class:bg-selected={groupView().characterTalks[i] <
                  (1 / 6) * barIndex}
                class:rounded-l-lg={barIndex === 1}
                class:rounded-r-lg={barIndex === 6}
                onclick={() =>
                  writeGroupMember(char, i, "set-talkness", (1 / 6) * barIndex)}
              ></button>
            {/each}
          </div>
          <div
            class="flex items-center justify-center"
            data-group-active={char}
            aria-busy={groupPending(char)}
          >
            <Check
              disabled={groupPending(char)}
              margin={false}
              bind:check={
                () => groupView().characterActive[i],
                (value) => writeGroupMember(char, i, "set-active", value)
              }
            />
          </div>
        {/each}
      {/if}
    </div>
    <div class="text-textcolor2 mt-1 flex mb-6">
      <button
        onclick={addGroupChar}
        data-group-add
        aria-label={language.addCharacter}
        aria-busy={groupPending()}
        disabled={groupPending()}
        class="hover:text-textcolor cursor-pointer"
      >
        <PlusIcon />
      </button>
    </div>
  {/if}
  <span class="text-textcolor"
    >{language.authorNote} <Help key="chatNote" /></span
  >
  <TextAreaInput
    margin="both"
    autocomplete="off"
    bind:value={
      () => getFieldValue(noteTarget(), currentChat().note),
      (value) =>
        setFieldValue(noteTarget(), value, () => {
          currentChat().note = value;
        })
    }
    highlight
    placeholder={getAuthorNoteDefaultText()}
  />
  <span class="text-textcolor2 mb-6 text-sm"
    >{tokens.localNote} {language.tokens}</span
  >

  {#if !$MobileGUI}
    <Toggles bind:chara={DBState.db.characters[$selectedCharID]} noContainer />

    {#if DBState.db.characters[$selectedCharID].type === "group"}
      <div class="flex mt-2 items-center">
        <Check
          bind:check={
            () => currentField("orderByOrder"),
            (value) => writeField("orderByOrder", value)
          }
          name={language.orderByOrder}
        />
      </div>
    {/if}
  {/if}
{:else if licensed === "private"}
  <span>You are not allowed</span>
  {(() => {
    $CharConfigSubMenu = 0;
  })()}
{:else if $CharConfigSubMenu === 1}
  {#if !$MobileGUI}
    <h2 class="mb-2 text-2xl font-bold mt-2">{language.characterDisplay}</h2>
  {/if}

  {#if entityRuntimeEnabled}
    {#key `${DBState.db.characters[$selectedCharID].chaId}:${currentChat().id}`}
      <RuntimeObjectFields
        dependencyGroups={[["image", "ccAssets"]]}
        targets={{
          ...Object.fromEntries(
            characterAssetFields.map((key) => [key, characterTarget(key)]),
          ),
          fmIndex: {
            scope: "chat",
            entityId: currentChat().id,
            key: "fmIndex",
          },
        }}
        values={{
          ...Object.fromEntries(
            characterAssetFields.map((key) => [
              key,
              (DBState.db.characters[$selectedCharID] as any)[key],
            ]),
          ),
          fmIndex: currentChat().fmIndex,
        }}
      >
        {#snippet children(draft)}<CharacterAssetSettings
            values={draft.values}
            capture={draft.capture}
            groupId={DBState.db.characters[$selectedCharID].type === "group"
              ? DBState.db.characters[$selectedCharID].chaId
              : undefined}
            bind:view={viewSubMenu}
          />{/snippet}
      </RuntimeObjectFields>
    {/key}
  {:else}
    <div class="flex w-full rounded-md border border-selected mb-4">
      <button
        onclick={() => {
          viewSubMenu = 0;
        }}
        class="p-2 flex-1"
        class:bg-selected={viewSubMenu === 0}
      >
        <span
          >{DBState.db.characters[$selectedCharID].type !== "group"
            ? language.charIcon
            : language.groupIcon}</span
        >
      </button>
      <button
        onclick={() => {
          viewSubMenu = 1;
        }}
        class="p2 flex-1 border-r border-l border-selected"
        class:bg-selected={viewSubMenu === 1}
      >
        <span>{language.viewScreen}</span>
      </button>
      <button
        onclick={() => {
          viewSubMenu = 2;
        }}
        class="p-2 flex-1"
        class:bg-selected={viewSubMenu === 2}
      >
        <span>{language.additionalAssets}</span>
      </button>
    </div>

    {#if viewSubMenu === 0}
      {#if DBState.db.characters[$selectedCharID].type === "group"}
        <button
          onclick={async () => {
            await selectCharImg($selectedCharID);
          }}
        >
          {#await getCharImage(DBState.db.characters[$selectedCharID].image, "css")}
            <div
              class="rounded-md h-24 w-24 shadow-lg bg-textcolor2 cursor-pointer ring-3"
            ></div>
          {:then im}
            <div
              class="rounded-md h-24 w-24 shadow-lg bg-textcolor2 cursor-pointer ring-3"
              style={im}
            ></div>
          {/await}
        </button>
      {:else}
        <div
          class="p-2 border-darkborderc border rounded-md flex flex-wrap gap-2"
        >
          {#if DBState.db.characters[$selectedCharID].image !== "" && DBState.db.characters[$selectedCharID].image}
            <button
              onclick={() => {
                if (
                  DBState.db.characters[$selectedCharID].type === "character" &&
                  DBState.db.characters[$selectedCharID].image !== "" &&
                  DBState.db.characters[$selectedCharID].image &&
                  iconRemoveMode
                ) {
                  DBState.db.characters[$selectedCharID].image = "";
                  if (
                    (DBState.db.characters[$selectedCharID] as character)
                      .ccAssets &&
                    (DBState.db.characters[$selectedCharID] as character)
                      .ccAssets.length > 0
                  ) {
                    changeCharImage($selectedCharID, 0);
                  }
                  iconRemoveMode = false;
                }
              }}
            >
              {#await getCharImage(DBState.db.characters[$selectedCharID].image, (DBState.db.characters[$selectedCharID] as character).largePortrait ? "lgcss" : "css")}
                <div
                  class="rounded-md h-24 w-24 shadow-lg bg-textcolor2 cursor-pointer ring-3 transition-shadow"
                  class:ring-red-500={iconRemoveMode}
                ></div>
              {:then im}
                <div
                  class="rounded-md h-24 w-24 shadow-lg bg-textcolor2 cursor-pointer ring-3 transition-shadow"
                  class:ring-red-500={iconRemoveMode}
                  style={im}
                ></div>
              {/await}
            </button>
          {/if}
          {#if (DBState.db.characters[$selectedCharID] as character).ccAssets}
            {#each (DBState.db.characters[$selectedCharID] as character).ccAssets as assets, i}
              <button
                onclick={async () => {
                  if (!iconRemoveMode) {
                    changeCharImage($selectedCharID, i);
                  } else if (
                    DBState.db.characters[$selectedCharID].type === "character"
                  ) {
                    (
                      DBState.db.characters[$selectedCharID] as character
                    ).ccAssets.splice(i, 1);
                    iconRemoveMode = false;
                  }
                }}
              >
                {#await getCharImage(assets.uri, (DBState.db.characters[$selectedCharID] as character).largePortrait ? "lgcss" : "css")}
                  <div
                    class="rounded-md h-24 w-24 shadow-lg bg-textcolor2 cursor-pointer hover:ring-3 transition-shadow"
                    class:ring-red-500={iconRemoveMode}
                    class:ring-3={iconRemoveMode}
                  ></div>
                {:then im}
                  <div
                    class="rounded-md h-24 w-24 shadow-lg bg-textcolor2 cursor-pointer hover:ring-3 transition-shadow"
                    style={im}
                    class:ring-red-500={iconRemoveMode}
                    class:ring-3={iconRemoveMode}
                  ></div>
                {/await}
              </button>
            {/each}
          {/if}
          <button
            onclick={async () => {
              await selectCharImg($selectedCharID);
            }}
          >
            <div
              class="rounded-md h-24 w-24 cursor-pointer border-darkborderc border border-dashed flex justify-center items-center hover:border-blue-500"
              style={(DBState.db.characters[$selectedCharID] as character)
                .largePortrait
                ? "height: 10.66rem;"
                : ""}
            >
              <PlusIcon />
            </div>
          </button>
        </div>
        <div class="flex w-full items-end justify-end mt-2">
          <button
            class={iconRemoveMode
              ? "text-red-500"
              : "text-textcolor2 hover:text-textcolor"}
            onclick={() => {
              iconRemoveMode = !iconRemoveMode;
            }}
          >
            <TrashIcon size="18" />
          </button>
        </div>
      {/if}

      {#if DBState.db.characters[$selectedCharID].type === "character" && DBState.db.characters[$selectedCharID].image !== ""}
        <div class="flex items-center mt-4">
          <Check
            bind:check={
              (DBState.db.characters[$selectedCharID] as character)
                .largePortrait
            }
            name={language.largePortrait}
          />
        </div>
      {/if}

      {#if DBState.db.characters[$selectedCharID].type === "group"}
        <Button onclick={makeGroupImage}>
          {language.createGroupImg}
        </Button>
      {/if}
    {:else if viewSubMenu === 1}
      <!-- svelte-ignore block_empty -->

      {#if DBState.db.characters[$selectedCharID].type !== "group"}
        <SelectInput
          className="mb-2"
          bind:value={DBState.db.characters[$selectedCharID].viewScreen}
          onchange={() => {
            if (DBState.db.characters[$selectedCharID].type === "character") {
              DBState.db.characters[$selectedCharID] = updateInlayScreen(
                DBState.db.characters[$selectedCharID] as character,
              );
            }
          }}
        >
          <OptionInput value="none">{language.none}</OptionInput>
          <OptionInput value="emotion">{language.emotionImage}</OptionInput>
          <OptionInput value="imggen">{language.imageGeneration}</OptionInput>
        </SelectInput>
      {:else}
        <SelectInput
          className="mb-2"
          bind:value={DBState.db.characters[$selectedCharID].viewScreen}
        >
          <OptionInput value="none">{language.none}</OptionInput>
          <OptionInput value="single">{language.singleView}</OptionInput>
          <OptionInput value="multiple">{language.SpacedView}</OptionInput>
          <OptionInput value="emp">{language.emphasizedView}</OptionInput>
        </SelectInput>
      {/if}

      {#if DBState.db.characters[$selectedCharID].viewScreen === "emotion"}
        <span class="text-textcolor mt-6"
          >{language.emotionImage} <Help key="emotion" /></span
        >
        <span class="text-textcolor2 text-xs">{language.emotionWarn}</span>

        <div class="w-full max-w-full border border-selected p-2 rounded-md">
          <table class="w-full max-w-full tabler">
            <tbody>
              <tr>
                <th class="font-medium w-1/3">{language.image}</th>
                <th class="font-medium w-1/2">{language.emotion}</th>
                <th class="font-medium"></th>
              </tr>
              {#if DBState.db.characters[$selectedCharID].emotionImages.length === 0}
                <tr>
                  <td colspan="3">{language.noImages}</td>
                </tr>
              {:else}
                {#each emos as emo, i}
                  <tr>
                    {#await getCharImage(emo[1], "plain")}
                      <td class="font-medium truncate w-1/3"></td>
                    {:then im}
                      <td class="font-medium truncate w-1/3"
                        ><img src={im} alt="img" class="w-full" /></td
                      >
                    {/await}
                    <td class="font-medium truncate w-1/2">
                      <TextInput
                        marginBottom
                        size="lg"
                        bind:value={
                          DBState.db.characters[$selectedCharID].emotionImages[
                            i
                          ][0]
                        }
                      />
                    </td>
                    <td>
                      <button
                        class="font-medium cursor-pointer hover:text-green-500"
                        onclick={() => {
                          rmCharEmotion($selectedCharID, i);
                        }}><TrashIcon /></button
                      >
                    </td>
                  </tr>
                {/each}
              {/if}
            </tbody>
          </table>
        </div>

        <div class="text-textcolor2 hover:text-textcolor mt-2 flex">
          {#if !$addingEmotion}
            <button
              class="cursor-pointer hover:text-green-500"
              onclick={() => {
                addCharEmotion($selectedCharID);
              }}
            >
              <PlusIcon />
            </button>
          {:else}
            <span>Loading...</span>
          {/if}
        </div>

        {#if (DBState.db.characters[$selectedCharID] as character).inlayViewScreen}
          <span class="text-textcolor mt-2">{language.imgGenInstructions}</span>
          <TextAreaInput
            highlight
            bind:value={
              (DBState.db.characters[$selectedCharID] as character).newGenData
                .emotionInstructions
            }
          />
        {/if}

        <CheckInput
          bind:check={
            (DBState.db.characters[$selectedCharID] as character)
              .inlayViewScreen
          }
          name={language.inlayViewScreen}
          onChange={() => {
            if (DBState.db.characters[$selectedCharID].type === "character") {
              if (
                (DBState.db.characters[$selectedCharID] as character)
                  .inlayViewScreen &&
                (DBState.db.characters[$selectedCharID] as character)
                  .additionalAssets === undefined
              ) {
                (
                  DBState.db.characters[$selectedCharID] as character
                ).additionalAssets = [];
              } else if (
                !(DBState.db.characters[$selectedCharID] as character)
                  .inlayViewScreen &&
                (DBState.db.characters[$selectedCharID] as character)
                  .additionalAssets.length === 0
              ) {
                (
                  DBState.db.characters[$selectedCharID] as character
                ).additionalAssets = undefined;
              }

              DBState.db.characters[$selectedCharID] = updateInlayScreen(
                DBState.db.characters[$selectedCharID] as character,
              );
            }
          }}
        />
      {/if}
      {#if DBState.db.characters[$selectedCharID].viewScreen === "imggen"}
        <span class="text-textcolor mt-6"
          >{language.imageGeneration} <Help key="imggen" /></span
        >
        <span class="text-textcolor2 text-xs">{language.emotionWarn}</span>

        <span class="text-textcolor mt-2">{language.imgGenPrompt}</span>
        <TextAreaInput
          highlight
          bind:value={
            (DBState.db.characters[$selectedCharID] as character).newGenData
              .prompt
          }
        />
        <span class="text-textcolor mt-2">{language.imgGenNegatives}</span>
        <TextAreaInput
          highlight
          bind:value={
            (DBState.db.characters[$selectedCharID] as character).newGenData
              .negative
          }
        />
        <span class="text-textcolor mt-2">{language.imgGenInstructions}</span>
        <TextAreaInput
          highlight
          bind:value={
            (DBState.db.characters[$selectedCharID] as character).newGenData
              .instructions
          }
        />

        <CheckInput
          bind:check={
            (DBState.db.characters[$selectedCharID] as character)
              .inlayViewScreen
          }
          name={language.inlayViewScreen}
          onChange={() => {
            if (
              (DBState.db.characters[$selectedCharID] as character).type ===
              "character"
            ) {
              (DBState.db.characters[$selectedCharID] as character) =
                updateInlayScreen(
                  DBState.db.characters[$selectedCharID] as character,
                );
            }
          }}
        />
      {/if}
    {:else if viewSubMenu === 2}
      {#if DBState.db.newImageHandlingBeta}
        <CheckInput
          bind:check={
            DBState.db.characters[$selectedCharID].prebuiltAssetCommand
          }
          name={language.insertAssetPrompt}
        />

        <span class="text-textcolor mt-2">{language.assetStyle}</span>
        <SelectInput
          className="mb-2"
          bind:value={DBState.db.characters[$selectedCharID].prebuiltAssetStyle}
        >
          <OptionInput value="">{language.static}</OptionInput>
          <OptionInput value="dynamic">{language.dynamic}</OptionInput>
        </SelectInput>
      {/if}
      <div class="w-full max-w-full border border-selected rounded-md p-2 mt-2">
        <table class="contain w-full max-w-full tabler mt-2">
          <tbody>
            <tr>
              <th class="font-medium">{language.value}</th>
              <th class="font-medium cursor-pointer w-10">
                <button
                  class="hover:text-green-500"
                  onclick={async () => {
                    if (
                      DBState.db.characters[$selectedCharID].type ===
                      "character"
                    ) {
                      const da = await selectMultipleFile([
                        "png",
                        "webp",
                        "mp4",
                        "mp3",
                        "gif",
                        "jpeg",
                        "jpg",
                        "ttf",
                        "otf",
                        "css",
                        "webm",
                        "woff",
                        "woff2",
                        "svg",
                        "avif",
                      ]);
                      DBState.db.characters[$selectedCharID].additionalAssets =
                        DBState.db.characters[$selectedCharID]
                          .additionalAssets ?? [];
                      if (!da) {
                        return;
                      }
                      for (const f of da) {
                        const img = f.data;
                        const name = f.name;
                        const extension = name.split(".").pop().toLowerCase();
                        const imgp = await saveAsset(img, "", extension);
                        DBState.db.characters[
                          $selectedCharID
                        ].additionalAssets.push([name, imgp, extension]);
                        DBState.db.characters[
                          $selectedCharID
                        ].additionalAssets =
                          DBState.db.characters[
                            $selectedCharID
                          ].additionalAssets;
                      }
                    }
                  }}
                >
                  <PlusIcon />
                </button>
              </th>
            </tr>
            {#if !DBState.db.characters[$selectedCharID].additionalAssets || DBState.db.characters[$selectedCharID].additionalAssets.length === 0}
              <tr>
                <td class="text-textcolor2"> No Assets</td>
              </tr>
            {:else}
              {#each DBState.db.characters[$selectedCharID].additionalAssets as assets, i}
                <tr>
                  <td class="font-medium truncate">
                    {#if assetFilePath[i] && DBState.db.useAdditionalAssetsPreview}
                      {#if assetFileExtensions[i] === "mp4"}
                        <!-- svelte-ignore a11y_media_has_caption -->
                        <video controls class="mt-2 px-2 w-full m-1 rounded-md"
                          ><source
                            src={assetFilePath[i]}
                            type="video/mp4"
                          /></video
                        >
                      {:else if assetFileExtensions[i] === "mp3"}
                        <audio
                          controls
                          class="mt-2 px-2 w-full h-16 m-1 rounded-md"
                          loop
                          ><source
                            src={assetFilePath[i]}
                            type="audio/mpeg"
                          /></audio
                        >
                      {:else if ["png", "webp", "jpeg", "jpg", "gif"].includes(assetFileExtensions[i])}
                        <img
                          src={assetFilePath[i]}
                          class="w-16 h-16 m-1 rounded-md"
                          alt={assets[0]}
                        />
                      {/if}
                    {/if}
                    <TextInput
                      size="sm"
                      marginBottom
                      bind:value={
                        DBState.db.characters[$selectedCharID].additionalAssets[
                          i
                        ][0]
                      }
                      placeholder="..."
                    />
                  </td>

                  <th class="font-medium cursor-pointer w-10">
                    <button
                      class="hover:text-blue-500"
                      onclick={() => {
                        if (
                          DBState.db.characters[$selectedCharID].type ===
                          "character"
                        ) {
                          DBState.db.characters[$selectedCharID].chats[
                            DBState.db.characters[$selectedCharID].chatPage
                          ].fmIndex = -1;
                          let additionalAssets =
                            DBState.db.characters[$selectedCharID]
                              .additionalAssets;
                          additionalAssets.splice(i, 1);
                          DBState.db.characters[
                            $selectedCharID
                          ].additionalAssets = additionalAssets;
                        }
                      }}
                    >
                      <TrashIcon />
                    </button>
                    {#if DBState.db.useAdditionalAssetsPreview}
                      <button
                        class="hover:text-blue-500"
                        class:text-textcolor2={DBState.db.characters[
                          $selectedCharID
                        ].prebuiltAssetExclude?.includes?.(assets[1])}
                        onclick={() => {
                          DBState.db.characters[
                            $selectedCharID
                          ].prebuiltAssetExclude ??= [];
                          if (
                            DBState.db.characters[
                              $selectedCharID
                            ].prebuiltAssetExclude.includes(assets[1])
                          ) {
                            DBState.db.characters[
                              $selectedCharID
                            ].prebuiltAssetExclude = DBState.db.characters[
                              $selectedCharID
                            ].prebuiltAssetExclude.filter(
                              (e) => e !== assets[1],
                            );
                          } else {
                            DBState.db.characters[
                              $selectedCharID
                            ].prebuiltAssetExclude.push(assets[1]);
                          }
                        }}
                      >
                        {#if DBState.db.characters[$selectedCharID]?.prebuiltAssetExclude?.includes?.(assets[1])}
                          <ImageOffIcon />
                        {:else}
                          <ImageIcon />
                        {/if}
                      </button>
                    {/if}
                  </th>
                </tr>
              {/each}
            {/if}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
{:else if $CharConfigSubMenu === 3}
  {#if !$MobileGUI}
    <h2 class="mb-2 text-2xl font-bold mt-2">
      {language.loreBook}
      <Help key="lorebook" />
    </h2>
  {/if}
  <LoreBook />
{:else if $CharConfigSubMenu === 4}
  {#if DBState.db.characters[$selectedCharID].type === "character"}
    {#if !$MobileGUI}
      <h2 class="mb-2 text-2xl font-bold mt-2">{language.scripts}</h2>
    {/if}

    <span class="text-textcolor mt-2"
      >{language.backgroundHTML} <Help key="backgroundHTML" /></span
    >
    <TextAreaInput
      highlight
      margin="both"
      autocomplete="off"
      bind:value={
        () => currentField("backgroundHTML"),
        (value) => writeField("backgroundHTML", value)
      }
    ></TextAreaInput>

    <span class="text-textcolor mt-4"
      >{language.regexScript} <Help key="regexScript" /></span
    >
    {#if entityRuntimeEnabled}
      {#key DBState.db.characters[$selectedCharID].chaId}
        <RuntimeObjectField
          target={characterTarget("customscript")}
          value={DBState.db.characters[$selectedCharID].customscript}
        >
          {#snippet children(draft)}
            <RegexList
              bind:value={draft.value}
              buttons
              onImport={async () => {
                try {
                  const captured = draft.capture();
                  captured.commit(await importRegex(captured.value));
                } catch (error) {
                  reportRuntimeError(error);
                }
              }}
            />
          {/snippet}
        </RuntimeObjectField>
      {/key}
    {:else}
      <RegexList
        bind:value={DBState.db.characters[$selectedCharID].customscript}
      />
      <div class="text-textcolor2 mt-2 flex gap-2">
        <button
          class="font-medium cursor-pointer hover:text-green-500"
          onclick={() => {
            if (DBState.db.characters[$selectedCharID].type === "character") {
              let script = DBState.db.characters[$selectedCharID].customscript;
              script.push({
                comment: "",
                in: "",
                out: "",
                type: "editinput",
              });
              DBState.db.characters[$selectedCharID].customscript = script;
            }
          }}><PlusIcon /></button
        >
        <button
          class="font-medium cursor-pointer hover:text-green-500"
          onclick={() => {
            exportRegex(DBState.db.characters[$selectedCharID].customscript);
          }}><DownloadIcon /></button
        >
        <button
          class="font-medium cursor-pointer hover:text-green-500"
          onclick={async () => {
            DBState.db.characters[$selectedCharID].customscript =
              await importRegex(
                DBState.db.characters[$selectedCharID].customscript,
              );
          }}><HardDriveUploadIcon /></button
        >
      </div>
    {/if}

    <span class="text-textcolor mt-4"
      >{language.triggerScript} <Help key="triggerScript" /></span
    >
    {#if entityRuntimeEnabled}
      {#key DBState.db.characters[$selectedCharID].chaId}
        <RuntimeObjectField
          target={characterTarget("triggerscript")}
          value={(DBState.db.characters[$selectedCharID] as character)
            .triggerscript}
        >
          {#snippet children(draft)}
            <TriggerList
              bind:value={draft.value}
              lowLevelAble={DBState.db.characters[$selectedCharID]
                .lowLevelAccess}
            />
          {/snippet}
        </RuntimeObjectField>
      {/key}
    {:else}
      <TriggerList
        bind:value={
          (DBState.db.characters[$selectedCharID] as character).triggerscript
        }
        lowLevelAble={DBState.db.characters[$selectedCharID].lowLevelAccess}
      />
    {/if}

    {#if DBState.db.characters[$selectedCharID].virtualscript || DBState.db.showUnrecommended}
      <span class="text-textcolor mt-4"
        >{language.charjs} <Help key="charjs" unrecommended /></span
      >
      <TextAreaInput
        margin="both"
        autocomplete="off"
        bind:value={
          () => currentField("virtualscript"),
          (value) => writeField("virtualscript", value)
        }
      ></TextAreaInput>
    {/if}
  {/if}
{:else if $CharConfigSubMenu === 6}
  {#if DBState.db.characters[$selectedCharID].license !== "CC BY-NC-SA 4.0" && DBState.db.characters[$selectedCharID].license !== "CC BY-SA 4.0"}
    <Button
      size="lg"
      onclick={async () => {
        if (await alertTOS()) {
          $ShowRealmFrameStore = "character";
        }
      }}
      className="mt-2"
    >
      {#if DBState.db.characters[$selectedCharID].realmId}
        {language.updateRealm}
      {:else}
        {language.shareCloud}
      {/if}
    </Button>
  {/if}

  {#if DBState.db.characters[$selectedCharID].license !== "CC BY-NC-SA 4.0" && DBState.db.characters[$selectedCharID].license !== "CC BY-SA 4.0" && DBState.db.characters[$selectedCharID].license !== "CC BY-ND 4.0" && DBState.db.characters[$selectedCharID].license !== "CC BY-NC-ND 4.0"}
    <Button
      size="sm"
      onclick={async () => {
        const res = await exportChar($selectedCharID);
      }}
      className="mt-2">{language.exportCharacter}</Button
    >
  {/if}

  <Button
    onclick={async () => {
      removeChar($selectedCharID, DBState.db.characters[$selectedCharID].name);
    }}
    className="mt-2"
    size="sm"
    >{DBState.db.characters[$selectedCharID].type === "group"
      ? language.removeGroup
      : language.removeCharacter}</Button
  >
{:else if $CharConfigSubMenu === 5}
  {#if DBState.db.characters[$selectedCharID].type === "character"}
    {@const currentCharacter = DBState.db.characters[
      $selectedCharID
    ] as character}
    {#if entityRuntimeEnabled}
      {#key currentCharacter.chaId}
        <RuntimeObjectFields
          targets={Object.fromEntries(
            characterTtsFields.map((key) => [
              key,
              {
                scope: "character" as const,
                entityId: currentCharacter.chaId,
                key,
              },
            ]),
          )}
          values={Object.fromEntries(
            characterTtsFields.map((key) => [key, currentCharacter[key]]),
          )}
        >
          {#snippet children(draft)}<CharacterTtsSettings
              values={draft.values}
              capture={draft.capture}
            />{/snippet}
        </RuntimeObjectFields>
      {/key}
    {:else}<CharacterTtsSettings values={currentCharacter} />{/if}
  {/if}
{:else if $CharConfigSubMenu === 2}
  {#if !$MobileGUI}
    <h2 class="mb-2 text-2xl font-bold mt-2">{language.advancedSettings}</h2>
  {/if}
  {#if DBState.db.characters[$selectedCharID].type !== "group"}
    {@const currentCharacter = DBState.db.characters[
      $selectedCharID
    ] as character}
    {@const chat = currentCharacter.chats[currentCharacter.chatPage]}
    {#if entityRuntimeEnabled}
      {#key JSON.stringify([currentCharacter.chaId, chat.id])}
        <RuntimeObjectFields
          targets={Object.fromEntries([
            ...definitionFields.map((key) => [
              key,
              {
                scope: "character" as const,
                entityId: currentCharacter.chaId,
                key,
              },
            ]),
            [
              "fmIndex",
              { scope: "chat" as const, entityId: chat.id, key: "fmIndex" },
            ],
          ])}
          values={{
            ...Object.fromEntries(
              definitionFields.map((key) => [key, currentCharacter[key]]),
            ),
            fmIndex: chat.fmIndex,
          }}
        >
          {#snippet children(draft)}
            <CharacterDefinitionSettings
              values={draft.values}
              normalizeNotesOnMount={false}
              onRemoveGreeting={() => {
                draft.values.fmIndex = -1;
              }}
            />
          {/snippet}
        </RuntimeObjectFields>
      {/key}
    {:else}
      <CharacterDefinitionSettings
        values={currentCharacter}
        onRemoveGreeting={() => {
          chat.fmIndex = -1;
        }}
      />
    {/if}

    {#if DBState.db.supaModelType !== "none" && DBState.db.hypav2}
      <Button
        onclick={() => {
          if (!entityRuntimeEnabled)
            DBState.db.characters[$selectedCharID].chats[
              DBState.db.characters[$selectedCharID].chatPage
            ].hypaV2Data ??= {
              lastMainChunkID: 0,
              mainChunks: [],
              chunks: [],
            };
          showHypaV2Alert();
        }}
        className="mt-4"
      >
        {language.hypaMemoryV2Modal}
      </Button>
    {:else if DBState.db.hypaV3}
      <Button
        onclick={() => {
          $hypaV3ModalOpen = true;
        }}
        className="mt-4"
      >
        {language.hypaMemoryV3Modal}
      </Button>
    {:else if (DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].supaMemoryData && DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].supaMemoryData.length > 4) || DBState.db.characters[$selectedCharID].supaMemory}
      <span class="text-textcolor mt-4">{language.SuperMemory}</span>
      <ChatMemoryText chat={currentChat()} />
    {/if}

    <div class="contents" data-runtime-character-module-action="apply">
      <Button
        onclick={() => {
          void applyModule().catch(reportRuntimeError);
        }}
        className="mt-4"
      >
        {language.applyModule}
      </Button>
    </div>

    <div class="contents" data-runtime-character-module-action="convert">
      <Button
        disabled={convertingModule}
        onclick={async () => {
          if (convertingModule) return;
          const char = getCurrentCharacter();
          if (char.type === "group") {
            return;
          }
          convertingModule = true;
          try {
            const m = convertCharacterToModule(
              entityRuntimeEnabled ? characterModuleSource(char) : char,
            );
            if (entityRuntimeEnabled)
              await browserRuntime().saveLibraryResource(
                "module",
                JSON.parse(JSON.stringify(m)),
              );
            else DBState.db.modules.push(m);
            alertNormal(language.successfullyConverted);
          } catch (error) {
            reportRuntimeError(error);
          } finally {
            convertingModule = false;
          }
        }}
        className="mt-4"
      >
        {language.convertToModule}
      </Button>
    </div>
  {:else}
    {#if (DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].supaMemoryData && DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].supaMemoryData.length > 4) || DBState.db.characters[$selectedCharID].supaMemory}
      <span class="text-textcolor mt-4">{language.SuperMemory}</span>
      <ChatMemoryText chat={currentChat()} />
    {/if}

    <div class="flex items-center mt-4">
      <Check
        bind:check={DBState.db.characters[$selectedCharID].lowLevelAccess}
        name={language.lowLevelAccess}
      />
      <span> <Help key="lowLevelAccess" name={language.lowLevelAccess} /></span>
    </div>
  {/if}
{/if}

<style>
  .tabler {
    table-layout: fixed;
  }

  .tabler td {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .char-grid {
    display: grid;
    grid-template-columns: auto 1fr auto;
  }
</style>
