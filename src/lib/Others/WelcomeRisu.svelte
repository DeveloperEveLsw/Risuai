<script lang="ts">
  import { onDestroy } from "svelte";
  import {
    entityRuntimeEnabled,
    reportRuntimeError,
  } from "src/ts/runtime/browserRuntimeState.svelte";
  import {
    getSettingDatabase,
    setSettingValues,
  } from "src/ts/runtime/fieldControls";
  import type { Json } from "src/ts/runtime/clientProtocol";
  let settings = $derived(getSettingDatabase(DBState.db));
  const writeSetting = (key: string, value: Json) =>
    setSettingValues(DBState.db, new Map([[key, value]]));
  let finishing = false;
  let finishTimer: ReturnType<typeof setTimeout>;
  onDestroy(() => clearTimeout(finishTimer));
  import { Send } from "@lucide/svelte";
  import { changeLanguage, language } from "src/lang";
  import { setPreset } from "src/ts/storage/database.svelte";
  import { DBState } from "src/ts/stores.svelte";
  import Chat from "../ChatScreens/Chat.svelte";
  import { prebuiltPresets } from "src/ts/process/templates/templates";
  import { updateTextThemeAndCSS } from "src/ts/gui/colorscheme";
  import { alertError } from "src/ts/alert";
  import Airisu from "../../etc/Airisu.webp";

  const airisuStyle = `background: url("${Airisu}");background-size: cover;`;
  let step = $state(0);
  let provider = $state("");
  let input = $state("");
  let chatLang = $state(0);
  let chatMemorySelection = $state(0);

  {
    const browserLang = navigator.language;
    const browserLangShort = browserLang.split("-")[0];
    const usableLangs = ["de", "en", "ko", "cn", "vi", "zh-Hant"];
    if (usableLangs.includes(browserLangShort)) {
      changeLanguage(browserLangShort);
      writeSetting("language", browserLangShort);
      step = 1;
    }
  }
  let start = $state(false);

  function send() {
    switch (step) {
      case 1: {
        if (input.length > 0) {
          writeSetting("username", input);
          step = 2;
          input = "";
        }
        break;
      }
      case 2: {
        if (
          ["openai", "openrouter", "horde", "later"].includes(
            input.toLocaleLowerCase(),
          )
        ) {
          provider = input.toLocaleLowerCase();
          step = 3;
          input = "";
        }
        break;
      }
      case 4: {
        if (input.length === 0) {
          break;
        }
        if (!input.startsWith("sk-")) {
          alertError("Invalid API key");
          break;
        }
        if (provider === "openai") {
          writeSetting("openAIKey", input);
        }
        if (provider === "openrouter") {
          writeSetting("openrouterKey", input);
        }
        if (provider === "claude") {
          writeSetting("claudeAPIKey", input);
        }
        step = 5;
        input = "";
        break;
      }
    }
  }

  $effect.pre(() => {
    if (step === 10 && !finishing) {
      finishing = true;
      finishTimer = setTimeout(() => {
        try {
          const before = entityRuntimeEnabled
            ? JSON.parse(
                JSON.stringify({
                  ...getSettingDatabase(DBState.db),
                  characters: [],
                }),
              )
            : null;
          let database = setPreset(
            before ? structuredClone(before) : DBState.db,
            prebuiltPresets.OAI2,
          );
          if (!entityRuntimeEnabled) DBState.db = database;
          database.textTheme = "highcontrast";
          if (!entityRuntimeEnabled) updateTextThemeAndCSS();

          switch (chatMemorySelection) {
            case 0: {
              database.maxContext = 16000;
              database.maxResponse = 1000;
              break;
            }
            case 1: {
              database.maxContext = 8000;
              database.maxResponse = 500;
              break;
            }
            case 2: {
              database.maxContext = 12000;
              database.maxResponse = 800;
              break;
            }
            case 3: {
              database.maxContext = 100000;
              database.maxResponse = 1000;
              break;
            }
          }

          if (provider === "claude") {
            database.aiModel = "claude-sonnet-4-6";
            database.subModel = "claude-sonnet-4-6";
          }

          if (provider === "openai") {
            database.aiModel = "gpt4o-chatgpt";
            database.subModel = "gpt4o-chatgpt";
          }

          if (provider === "openrouter") {
            database.aiModel = "openrouter";
            database.subModel = "openrouter";
            database.openrouterRequestModel = "risu/free";
          }
          if (provider === "horde") {
            database.aiModel = "horde:::auto";
            database.subModel = "horde:::auto";
          }
          if (chatLang !== 0) {
            switch (database.language) {
              case "de": {
                database.translator = "de";
                break;
              }
              case "en": {
                database.translator = "en";
                break;
              }
              case "ko": {
                database.translator = "ko";
                break;
              }
              case "cn": {
                database.translator = "zh";
                break;
              }
              case "vi": {
                database.translator = "vi";
                break;
              }
              case "zh-Hant": {
                database.translator = "zh-TW";
                break;
              }
            }
          }
          if (chatLang === 1) {
            database.autoTranslate = true;
            database.translatorType = "google";
            database.useAutoTranslateInput = true;
          }

          database.didFirstSetup = true;
          database.claudeCachingExperimental = true;
          if (before) {
            const excluded = new Set([
              "characters",
              "modules",
              "botPresets",
              "personas",
              "plugins",
              "globalChatVariables",
            ]);
            const values = new Map<string, Json | undefined>();
            for (const key of new Set([
              ...Object.keys(before),
              ...Object.keys(database),
            ]))
              if (
                !excluded.has(key) &&
                JSON.stringify(before[key]) !== JSON.stringify(database[key])
              )
                values.set(key, database[key]);
            setSettingValues(DBState.db, values);
          }
        } catch (error) {
          finishing = false;
          reportRuntimeError(error);
        }
      }, 1000);
    }
  });
</script>

<div
  class="w-full h-full flex justify-center welcome-bg text-textcolor relative bg-gray-900"
>
  <div
    class="w-2xl overflow-x-hidden max-w-full min-h-full h-full flex flex-col overflow-y-hidden"
    class:justify-center={!start}
  >
    {#if !start}
      <div
        class="w-full justify-center flex mt-8 logo-animation"
        onanimationend={() => {
          start = true;
        }}
      >
        <img
          src="/logo_typo_trans.png"
          alt="logo"
          class="w-full max-w-(--breakpoint-sm) mb-0"
        />
      </div>
    {:else}
      <div
        class="relative w-full flex-col bg-darkbg grow mt-5 max-w-full p-5 rounded-t-lg overflow-x-hidden flex border-gray-800 border chat-animation overflow-y-auto"
      >
        {#if step === 0}
          <h2 class="animate-bounce">Choose your language</h2>
          <div class="flex flex-col items-start ml-2">
            <button
              class="hover:text-green-500 transition-colors"
              onclick={() => {
                changeLanguage("de");
                writeSetting("language", "de");
                step = 1;
              }}>• Deutsch</button
            >
            <button
              class="hover:text-green-500 transition-colors"
              onclick={() => {
                changeLanguage("en");
                writeSetting("language", "en");
                step = 1;
              }}>• English</button
            >
            <button
              class="hover:text-green-500 transition-colors"
              onclick={() => {
                changeLanguage("ko");
                writeSetting("language", "ko");
                step = 1;
              }}>• 한국어</button
            >
            <button
              class="hover:text-green-500 transition-colors"
              onclick={() => {
                changeLanguage("cn");
                writeSetting("language", "cn");
                step = 1;
              }}>• 中文</button
            >
            <button
              class="hover:text-green-500 transition-colors"
              onclick={() => {
                changeLanguage("zh-Hant");
                writeSetting("language", "zh-Hant");
                step = 1;
              }}>• 中文(繁體)</button
            >
            <button
              class="hover:text-green-500 transition-colors"
              onclick={() => {
                changeLanguage("vi");
                writeSetting("language", "vi");
                step = 1;
              }}>• Tiếng Việt</button
            >
          </div>
        {:else}
          <Chat
            name="Airisu"
            img={airisuStyle}
            message={language.setup.welcome}
            isLastMemory={false}
          />
          {#if step >= 2}
            <Chat
              name={settings.username}
              message={settings.username}
              isLastMemory={false}
            />
            <Chat
              name="Airisu"
              img={airisuStyle}
              message={language.setup.setupLaterMessage.replace(
                "{username}",
                settings.username,
              )}
              isLastMemory={false}
            />
          {/if}
          {#if step === 2}
            <div class="grid grid-cols-2 gap-4 md:grid-cols-3">
              <button
                class="border-l-blue-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1 col-span-2"
                onclick={() => {
                  step = 3;
                }}
              >
                <h1 class="text-2xl font-bold text-start">
                  {language.setup.setupMessageOption1}
                </h1>
                <span class="mt-2 text-textcolor2 text-start"
                  >{language.setup.setupMessageOption1Desc}</span
                >
              </button>
              <button
                class="border-l-gray-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1"
                onclick={() => {
                  provider = "later";
                  step = 10;
                }}
              >
                <h1 class="text-md font-bold text-start text-gray-500">
                  {language.setup.setupMessageOption2}
                </h1>
              </button>
            </div>
          {/if}
          {#if step >= 3}
            <Chat
              name={settings.username}
              message={language.setup.setupMessageOption1}
              isLastMemory={false}
            />
            <Chat
              name="Airisu"
              img={airisuStyle}
              message={language.setup.welcome2.replace(
                "{username}",
                settings.username,
              )}
              isLastMemory={false}
            />
          {/if}
          {#if step === 3}
            <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
              <button
                class="border-l-gray-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1"
                onclick={() => {
                  provider = "claude";
                  step = 4;
                }}
              >
                <h1 class="text-2xl font-bold text-start">
                  Claude <span
                    class="text-sm p-1 rounded-sm bg-blue-500 text-white"
                    >{language.recommended}</span
                  >
                </h1>
                <span class="mt-2 text-textcolor2 text-start"
                  >{language.setup.claudeDesc}</span
                >
              </button>
              <button
                class="border-l-blue-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1"
                onclick={() => {
                  provider = "openai";
                  step = 4;
                }}
              >
                <h1 class="text-2xl font-bold text-start">OpenAI</h1>
                <span class="mt-2 text-textcolor2 text-start"
                  >{language.setup.openAIDesc}</span
                >
              </button>
              <button
                class="border-l-red-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1"
                onclick={() => {
                  provider = "horde";
                  step = 10;
                }}
              >
                <h1 class="text-2xl font-bold text-start">Horde</h1>
                <span class="mt-2 text-textcolor2 text-start"
                  >{language.setup.hordeProvider}</span
                >
              </button>
              <button
                class="border-l-green-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1"
                onclick={() => {
                  provider = "openrouter";
                  step = 4;
                }}
              >
                <h1 class="text-2xl font-bold text-start">OpenRouter</h1>
                <span class="mt-2 text-textcolor2 text-start"
                  >{language.setup.openRouterProvider}</span
                >
              </button>
            </div>
          {/if}
          {#if step >= 4}
            <Chat
              name={settings.username}
              message={provider}
              isLastMemory={false}
            />
            {#if provider === "openai"}
              <Chat
                name="Airisu"
                img={airisuStyle}
                message={language.setup.setupOpenAI}
                isLastMemory={false}
              />
            {/if}
            {#if provider === "openrouter"}
              <Chat
                name="Airisu"
                img={airisuStyle}
                message={language.setup.setupOpenRouter}
                isLastMemory={false}
              />
            {/if}
            {#if provider === "claude"}
              {#each language.setup.setupClaudeSteps as step, i}
                <Chat
                  name="Airisu"
                  img={airisuStyle}
                  message={`![alt text](/welcome/claude/ant_${i}.webp)\n\n${i === 0 ? "https://console.anthropic.com/login?returnTo=%2F%3F\n\n" : ""}` +
                    step}
                  isLastMemory={false}
                />
              {/each}
            {/if}
          {/if}
          {#if step >= 5}
            <Chat
              name={settings.username}
              message="<HIDDEN>"
              isLastMemory={false}
            />
            <Chat
              name="Airisu"
              img={airisuStyle}
              message={language.setup.chooseChatType}
              isLastMemory={false}
            />
          {/if}
          {#if step === 5}
            <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
              <button
                class="border-l-blue-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1"
                onclick={() => {
                  chatLang = 0;
                  step = 6;
                }}
              >
                <h1 class="text-2xl font-bold text-start">
                  {language.setup.chooseChatTypeOption1}
                </h1>
                <span class="mt-2 text-textcolor2 text-start"
                  >{language.setup.chooseChatTypeOption1Desc}</span
                >
              </button>
              <button
                class="border-l-green-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1"
                onclick={() => {
                  chatLang = 1;
                  step = 6;
                }}
              >
                <h1 class="text-2xl font-bold text-start">
                  {language.setup.chooseChatTypeOption2}
                </h1>
                <span class="mt-2 text-textcolor2 text-start"
                  >{language.setup.chooseChatTypeOption2Desc}</span
                >
              </button>
              <button
                class="border-l-red-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1"
                onclick={() => {
                  chatLang = 2;
                  step = 6;
                }}
              >
                <h1 class="text-2xl font-bold text-start">
                  {language.setup.chooseChatTypeOption3}
                </h1>
                <span class="mt-2 text-textcolor2 text-start"
                  >{language.setup.chooseChatTypeOption3Desc}</span
                >
              </button>
            </div>
          {/if}
          {#if step >= 6}
            <Chat
              name={settings.username}
              message={language.setup[`chooseChatTypeOption${chatLang + 1}`]}
              isLastMemory={false}
            />
            <Chat
              name="Airisu"
              img={airisuStyle}
              message={language.setup.chooseCheapOrMemory}
              isLastMemory={false}
            />
          {/if}
          {#if step === 6}
            <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
              <button
                class="border-l-red-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1"
                onclick={() => {
                  chatMemorySelection = 2;
                  step = 10;
                }}
              >
                <h1 class="text-2xl font-bold text-start">
                  {language.setup.chooseCheapOrMemoryOption3}
                  <span class="text-sm p-1 rounded-sm bg-blue-500 text-white"
                    >{language.recommended}</span
                  >
                </h1>
                <span class="mt-2 text-textcolor2 text-start"
                  >{language.setup.chooseCheapOrMemoryOption3Desc}</span
                >
              </button>
              <button
                class="border-l-blue-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1"
                onclick={() => {
                  chatMemorySelection = 0;
                  step = 10;
                }}
              >
                <h1 class="text-2xl font-bold text-start">
                  {language.setup.chooseCheapOrMemoryOption1}
                </h1>
                <span class="mt-2 text-textcolor2 text-start"
                  >{language.setup.chooseCheapOrMemoryOption1Desc}</span
                >
              </button>
              <button
                class="border-l-green-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1"
                onclick={() => {
                  chatMemorySelection = 1;
                  step = 10;
                }}
              >
                <h1 class="text-2xl font-bold text-start">
                  {language.setup.chooseCheapOrMemoryOption2}
                </h1>
                <span class="mt-2 text-textcolor2 text-start"
                  >{language.setup.chooseCheapOrMemoryOption2Desc}</span
                >
              </button>
              <button
                class="border-l-yellow-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1"
                onclick={() => {
                  chatMemorySelection = 3;
                  step = 10;
                }}
              >
                <h1 class="text-2xl font-bold text-start">
                  {language.setup.chooseCheapOrMemoryOption4}
                </h1>
                <span class="mt-2 text-textcolor2 text-start"
                  >{language.setup.chooseCheapOrMemoryOption4Desc}</span
                >
              </button>
            </div>
          {/if}
          {#if step === 10}
            <Chat
              name="Airisu"
              img={airisuStyle}
              message={language.setup.allDone}
              isLastMemory={false}
            />
          {/if}
          <div class="flex items-stretch mb-2 w-full mt-auto">
            <textarea
              class="peer focus:border-textcolor transition-colors outline-hidden text-textcolor p-2 min-w-0 border border-r-0 bg-transparent rounded-md rounded-r-none input-text text-xl grow ml-4 border-darkborderc resize-none overflow-y-hidden overflow-x-hidden max-w-full"
              bind:value={input}
              onkeydown={(e) => {
                if (
                  e.key.toLocaleLowerCase() === "enter" &&
                  !e.shiftKey &&
                  !e.isComposing
                ) {
                  e.preventDefault();
                  send();
                }
              }}
              style:height={"44px"}
            ></textarea>
            <button
              onclick={send}
              class="flex justify-center border-y border-r rounded-r-md border-darkborderc items-center text-textcolor p-2 peer-focus:border-textcolor hover:bg-blue-500 hover:text-white transition-colors"
            >
              <Send />
            </button>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .welcome-bg {
    background-size: cover;
    position: relative;
  }

  @keyframes darkness {
    from {
      opacity: 0;
    }
    50% {
      opacity: 0.2;
    }
    to {
      opacity: 0;
    }
  }

  .logo-animation {
    animation: logo-animation 3s ease-in-out;
    opacity: 0;
  }
  @keyframes logo-animation {
    from {
      opacity: 0;
    }
    80% {
      opacity: 1;
    }
    to {
      opacity: 0;
    }
  }

  .chat-animation {
    animation: chat-animation 3s ease-in-out;
  }
  @keyframes chat-animation {
    from {
      top: 100vh;
    }
    to {
      top: 0;
    }
  }
</style>
