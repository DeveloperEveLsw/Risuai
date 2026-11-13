<script lang="ts">
  import { language } from "src/lang";
  import { DBState, MobileGUI } from "src/ts/stores.svelte";
  import {
    getElevenTTSVoices,
    getWebSpeechTTSVoices,
    getVOICEVOXVoices,
    oaiVoices,
    getNovelAIVoices,
  } from "src/ts/process/tts";
  import { registerOnnxModel } from "src/ts/process/transformers";
  import { selectSingleFile } from "src/ts/util";
  import { saveAsset } from "src/ts/globalApi.svelte";
  import {
    characterTtsConfig,
    characterTtsDefaults,
    characterTtsProviderConfig,
  } from "src/ts/runtime/characterTtsControls";
  import { reportRuntimeError } from "src/ts/runtime/browserRuntimeState.svelte";
  import TextInput from "../UI/GUI/TextInput.svelte";
  import TextAreaInput from "../UI/GUI/TextAreaInput.svelte";
  import NumberInput from "../UI/GUI/NumberInput.svelte";
  import SliderInput from "../UI/GUI/SliderInput.svelte";
  import SelectInput from "../UI/GUI/SelectInput.svelte";
  import OptionInput from "../UI/GUI/OptionInput.svelte";
  import Check from "../UI/GUI/CheckInput.svelte";
  import Button from "../UI/GUI/Button.svelte";
  let {
    values,
    capture,
  }: {
    values: any;
    capture?: (names: string[]) => {
      values: any;
      commit: (values: Record<string, unknown>) => void;
    };
  } = $props();
  const config = (key: string) => characterTtsConfig(values, key);
  function read(key: string, path: string[], fallback: any) {
    let value = path.length ? config(key) : values[key];
    for (const part of path) value = value?.[part];
    return value ?? fallback;
  }
  function write(key: string, path: string[], value: any, fallback: any) {
    if (Object.is(read(key, path, fallback), value)) return;
    if (!path.length) {
      values[key] = value;
      return;
    }
    const next = config(key);
    let owner = next;
    for (const part of path.slice(0, -1)) {
      owner[part] = { ...owner[part] };
      owner = owner[part];
    }
    owner[path[path.length - 1]] = value;
    values[key] = next;
  }
  function changeMode(value: any) {
    if (value === read("ttsMode", [], "")) return;
    values.ttsMode = value;
    values.ttsSpeech = "";
    const key = characterTtsProviderConfig[value];
    if (key && values[key] === undefined)
      values[key] = JSON.parse(JSON.stringify(characterTtsDefaults[key]));
  }
  function captured(names: string[]) {
    if (capture) return capture(names);
    const owner = values;
    return {
      values: Object.fromEntries(
        names.map((key) => [
          key,
          owner[key] === undefined
            ? undefined
            : JSON.parse(JSON.stringify(owner[key])),
        ]),
      ),
      commit(next: Record<string, unknown>) {
        for (const key of names) owner[key] = next[key];
      },
    };
  }
  async function selectVits() {
    try {
      const before = captured(["vits", "ttsMode"]);
      const model = await registerOnnxModel();
      if (model) before.commit({ ...before.values, vits: model });
    } catch (error) {
      reportRuntimeError(error);
    }
  }
  async function selectReferenceAudio() {
    try {
      const before = captured(["gptSoVitsConfig", "ttsMode"]);
      const audio = await selectSingleFile(["wav", "ogg", "aac", "mp3"]);
      if (!audio) return;
      const saveId = await saveAsset(audio.data, "", audio.name);
      const next = characterTtsConfig(before.values, "gptSoVitsConfig");
      next.ref_audio_data = {
        ...next.ref_audio_data,
        fileName: audio.name,
        assetId: saveId,
      };
      before.commit({ ...before.values, gptSoVitsConfig: next });
    } catch (error) {
      reportRuntimeError(error);
    }
  }
  let fishSpeechModels: { _id: string; title: string; description: string }[] =
    $state([]);
  async function getFishSpeechModels() {
    try {
      const res = await fetch("https://api.fish.audio/model?self=true", {
        headers: { Authorization: `Bearer ${DBState.db.fishSpeechKey}` },
      });
      const data = await res.json();
      fishSpeechModels = Array.isArray(data.items)
        ? data.items.map((item) => ({
            _id: item._id || "",
            title: item.title || "",
            description: item.description || "",
          }))
        : [];
    } catch (error) {
      console.error("Error fetching fish speech models:", error);
      fishSpeechModels = [];
    }
  }
</script>

<div data-runtime-tts-settings style="display:contents">
  {#if !$MobileGUI}<h2 class="mb-2 text-2xl font-bold mt-2">TTS</h2>{/if}
  <span class="text-textcolor">{language.provider}</span>
  <div data-runtime-tts-field="ttsMode" style="display:contents">
    <SelectInput
      className="mb-4 mt-2"
      bind:value={() => read("ttsMode", [], ""), changeMode}
    >
      <OptionInput value="">{language.disabled}</OptionInput>
      <OptionInput value="elevenlab">ElevenLabs</OptionInput>
      <OptionInput value="webspeech">Web Speech</OptionInput>
      <OptionInput value="VOICEVOX">VOICEVOX</OptionInput>
      <OptionInput value="openai">OpenAI</OptionInput>
      <OptionInput value="novelai">NovelAI</OptionInput>
      <OptionInput value="huggingface">Huggingface</OptionInput>
      <OptionInput value="vits">VITS</OptionInput>
      <OptionInput value="gptsovits">GPT-SoVITS</OptionInput>
      <OptionInput value="fishspeech">fish-speech</OptionInput>
    </SelectInput>
  </div>

  {#if values.ttsMode === "webspeech"}
    {#if typeof speechSynthesis === "undefined"}
      <span class="text-textcolor"
        >Web Speech isn't supported in your browser or OS</span
      >
    {:else}
      <span class="text-textcolor">{language.Speech}</span>
      <div data-runtime-tts-field="ttsSpeech" style="display:contents">
        <SelectInput
          className="mb-4 mt-2"
          bind:value={
            () => read("ttsSpeech", [], ""),
            (value) => write("ttsSpeech", [], value, "")
          }
        >
          <OptionInput value="">Auto</OptionInput>
          {#each getWebSpeechTTSVoices() as voice}
            <OptionInput value={voice}>{voice}</OptionInput>
          {/each}
        </SelectInput>
      </div>
      {#if values.ttsSpeech !== ""}
        <span class="text-red-400 text-sm"
          >If you do not set it to Auto, it may not work properly when importing
          from another OS or browser.</span
        >
      {/if}
    {/if}
  {:else if values.ttsMode === "elevenlab"}
    <span class="text-sm mb-2 text-textcolor2"
      >Please set the ElevenLabs API key in "global Settings → Bot Settings →
      Others → ElevenLabs API key"</span
    >
    {#await getElevenTTSVoices() then voices}
      <span class="text-textcolor">{language.Speech}</span>
      <div data-runtime-tts-field="ttsSpeech" style="display:contents">
        <SelectInput
          className="mb-4 mt-2"
          bind:value={
            () => read("ttsSpeech", [], ""),
            (value) => write("ttsSpeech", [], value, "")
          }
        >
          <OptionInput value="">Unset</OptionInput>
          {#each voices as voice}
            <OptionInput value={voice.voice_id}>{voice.name}</OptionInput>
          {/each}
        </SelectInput>
      </div>
    {/await}
  {:else if values.ttsMode === "VOICEVOX"}
    <span class="text-textcolor">Speaker</span>
    <div
      data-runtime-tts-field="voicevoxConfig.speaker"
      style="display:contents"
    >
      <SelectInput
        className="mb-4 mt-2"
        bind:value={
          () => read("voicevoxConfig", ["speaker"], ""),
          (value) => write("voicevoxConfig", ["speaker"], value, "")
        }
      >
        {#await getVOICEVOXVoices() then voices}
          {#each voices as voice}
            <OptionInput
              value={voice.list}
              selected={config("voicevoxConfig").speaker === voice.list}
              >{voice.name}</OptionInput
            >
          {/each}
        {/await}
      </SelectInput>
    </div>
    {#if config("voicevoxConfig").speaker}
      <span class="text=neutral-200">Style</span>
      <div data-runtime-tts-field="ttsSpeech" style="display:contents">
        <SelectInput
          className="mb-4 mt-2"
          bind:value={
            () => read("ttsSpeech", [], ""),
            (value) => write("ttsSpeech", [], value, "")
          }
        >
          {#each JSON.parse(config("voicevoxConfig").speaker) as styles}
            <OptionInput
              value={styles.id}
              selected={values.ttsSpeech === styles.id}
              >{styles.name}</OptionInput
            >
          {/each}
        </SelectInput>
      </div>
    {/if}
    <span class="text-textcolor">Speed scale</span>
    <div
      data-runtime-tts-field="voicevoxConfig.SPEED_SCALE"
      style="display:contents"
    >
      <NumberInput
        id="runtime-tts-voicevoxConfig.SPEED_SCALE"
        size={"sm"}
        marginBottom
        bind:value={
          () => read("voicevoxConfig", ["SPEED_SCALE"], 0),
          (value) => write("voicevoxConfig", ["SPEED_SCALE"], value, 0)
        }
      />
    </div>

    <span class="text-textcolor">Pitch scale</span>
    <div
      data-runtime-tts-field="voicevoxConfig.PITCH_SCALE"
      style="display:contents"
    >
      <NumberInput
        id="runtime-tts-voicevoxConfig.PITCH_SCALE"
        size={"sm"}
        marginBottom
        bind:value={
          () => read("voicevoxConfig", ["PITCH_SCALE"], 0),
          (value) => write("voicevoxConfig", ["PITCH_SCALE"], value, 0)
        }
      />
    </div>

    <span class="text-textcolor">Volume scale</span>
    <div
      data-runtime-tts-field="voicevoxConfig.VOLUME_SCALE"
      style="display:contents"
    >
      <NumberInput
        id="runtime-tts-voicevoxConfig.VOLUME_SCALE"
        size={"sm"}
        marginBottom
        bind:value={
          () => read("voicevoxConfig", ["VOLUME_SCALE"], 0),
          (value) => write("voicevoxConfig", ["VOLUME_SCALE"], value, 0)
        }
      />
    </div>

    <span class="text-textcolor">Intonation scale</span>
    <div
      data-runtime-tts-field="voicevoxConfig.INTONATION_SCALE"
      style="display:contents"
    >
      <NumberInput
        id="runtime-tts-voicevoxConfig.INTONATION_SCALE"
        size={"sm"}
        marginBottom
        bind:value={
          () => read("voicevoxConfig", ["INTONATION_SCALE"], 0),
          (value) => write("voicevoxConfig", ["INTONATION_SCALE"], value, 0)
        }
      />
    </div>
    <span class="text-sm mb-2 text-textcolor2"
      >To use VOICEVOX, you need to run a colab and put the localtunnel URL in
      "Settings → Other Bots".
      https://colab.research.google.com/drive/1tyeXJSklNfjW-aZJAib1JfgOMFarAwze</span
    >
  {:else if values.ttsMode === "novelai"}
    <span class="text-textcolor">Custom Voice Seed</span>
    <div
      data-runtime-tts-field="naittsConfig.customvoice"
      style="display:contents"
    >
      <Check
        bind:check={
          () => read("naittsConfig", ["customvoice"], false),
          (value) => write("naittsConfig", ["customvoice"], value, false)
        }
      />
    </div>
    {#if !config("naittsConfig").customvoice}
      <span class="text-textcolor">Voice</span>
      <div data-runtime-tts-field="naittsConfig.voice" style="display:contents">
        <SelectInput
          className="mb-4 mt-2"
          bind:value={
            () => read("naittsConfig", ["voice"], ""),
            (value) => write("naittsConfig", ["voice"], value, "")
          }
        >
          {#await getNovelAIVoices() then voices}
            {#each voices as voiceGroup}
              <optgroup
                label={voiceGroup.gender}
                class="bg-darkbg appearance-none"
              >
                {#each voiceGroup.voices as voice}
                  <OptionInput
                    value={voice}
                    selected={config("naittsConfig").voice === voice}
                    >{voice}</OptionInput
                  >
                {/each}
              </optgroup>
            {/each}
          {/await}
        </SelectInput>
      </div>
    {:else}
      <span class="text-textcolor">Voice</span>
      <div data-runtime-tts-field="naittsConfig.voice" style="display:contents">
        <TextInput
          id="runtime-tts-naittsConfig.voice"
          size={"sm"}
          bind:value={
            () => read("naittsConfig", ["voice"], ""),
            (value) => write("naittsConfig", ["voice"], value, "")
          }
        />
      </div>
    {/if}
    <span class="text-textcolor">Version</span>
    <div data-runtime-tts-field="naittsConfig.version" style="display:contents">
      <SelectInput
        className="mb-4 mt-2"
        bind:value={
          () => read("naittsConfig", ["version"], ""),
          (value) => write("naittsConfig", ["version"], value, "")
        }
      >
        <OptionInput value="v1">v1</OptionInput>
        <OptionInput value="v2">v2</OptionInput>
      </SelectInput>
    </div>
  {:else if values.ttsMode === "openai"}
    <span class="text-textcolor">Voice</span>
    {#if !config("oaiTTSConfig")?.enabled}
      <div data-runtime-tts-field="oaiVoice" style="display:contents">
        <SelectInput
          className="mb-4 mt-2"
          bind:value={
            () => read("oaiVoice", [], ""),
            (value) => write("oaiVoice", [], value, "")
          }
        >
          <OptionInput value="">Unset</OptionInput>
          {#each oaiVoices as voice}
            <OptionInput value={voice}>{voice}</OptionInput>
          {/each}
        </SelectInput>
      </div>
    {:else}
      <div data-runtime-tts-field="oaiTTSConfig.voice" style="display:contents">
        <TextInput
          id="runtime-tts-oaiTTSConfig.voice"
          className="mb-4 mt-2"
          bind:value={
            () => read("oaiTTSConfig", ["voice"], ""),
            (value) => write("oaiTTSConfig", ["voice"], value, "")
          }
          placeholder={values.oaiVoice || "alloy"}
        />
      </div>
    {/if}

    <span class="text-textcolor">Advanced (OpenAI-compatible endpoint)</span>
    <div data-runtime-tts-field="oaiTTSConfig.enabled" style="display:contents">
      <Check
        bind:check={
          () => read("oaiTTSConfig", ["enabled"], false),
          (value) => write("oaiTTSConfig", ["enabled"], value, false)
        }
      />
    </div>

    {#if config("oaiTTSConfig")?.enabled}
      <span class="text-textcolor">Base URL</span>
      <div
        data-runtime-tts-field="oaiTTSConfig.baseURL"
        style="display:contents"
      >
        <TextInput
          id="runtime-tts-oaiTTSConfig.baseURL"
          className="mb-4 mt-2"
          bind:value={
            () => read("oaiTTSConfig", ["baseURL"], ""),
            (value) => write("oaiTTSConfig", ["baseURL"], value, "")
          }
          placeholder="https://api.openai.com/v1"
        />
      </div>

      <span class="text-textcolor">API Key (overrides global)</span>
      <div
        data-runtime-tts-field="oaiTTSConfig.apiKey"
        style="display:contents"
      >
        <TextInput
          id="runtime-tts-oaiTTSConfig.apiKey"
          className="mb-4 mt-2"
          hideText={DBState.db.hideApiKey}
          bind:value={
            () => read("oaiTTSConfig", ["apiKey"], ""),
            (value) => write("oaiTTSConfig", ["apiKey"], value, "")
          }
          placeholder="Leave empty to use global OpenAI API key"
        />
      </div>

      <span class="text-textcolor">Model</span>
      <div data-runtime-tts-field="oaiTTSConfig.model" style="display:contents">
        <TextInput
          id="runtime-tts-oaiTTSConfig.model"
          className="mb-4 mt-2"
          bind:value={
            () => read("oaiTTSConfig", ["model"], ""),
            (value) => write("oaiTTSConfig", ["model"], value, "")
          }
          placeholder="tts-1"
        />
      </div>

      <span class="text-textcolor">Response Format</span>
      <div
        data-runtime-tts-field="oaiTTSConfig.format"
        style="display:contents"
      >
        <SelectInput
          className="mb-4 mt-2"
          bind:value={
            () => read("oaiTTSConfig", ["format"], ""),
            (value) => write("oaiTTSConfig", ["format"], value, "")
          }
        >
          <OptionInput value="mp3">mp3</OptionInput>
          <OptionInput value="opus">opus</OptionInput>
          <OptionInput value="aac">aac</OptionInput>
          <OptionInput value="flac">flac</OptionInput>
          <OptionInput value="wav">wav</OptionInput>
          <OptionInput value="pcm">pcm</OptionInput>
        </SelectInput>
      </div>
    {/if}
  {:else if values.ttsMode === "huggingface"}
    <span class="text-textcolor">Model</span>
    <div data-runtime-tts-field="hfTTS.model" style="display:contents">
      <TextInput
        id="runtime-tts-hfTTS.model"
        className="mb-4 mt-2"
        bind:value={
          () => read("hfTTS", ["model"], ""),
          (value) => write("hfTTS", ["model"], value, "")
        }
      />
    </div>

    <span class="text-textcolor">Language</span>
    <div data-runtime-tts-field="hfTTS.language" style="display:contents">
      <TextInput
        id="runtime-tts-hfTTS.language"
        className="mb-4 mt-2"
        bind:value={
          () => read("hfTTS", ["language"], ""),
          (value) => write("hfTTS", ["language"], value, "")
        }
        placeholder="en"
      />
    </div>
  {:else if values.ttsMode === "vits"}
    {#if values.vits}
      <span class="text-textcolor"
        >{values.vits.name ?? "Unnamed VitsModel"}</span
      >
    {:else}
      <span class="text-textcolor">No Model</span>
    {/if}
    <Button onclick={selectVits}>{language.selectModel}</Button>
  {:else if values.ttsMode === "gptsovits"}
    <span class="text-textcolor">Volume</span>
    <div
      data-runtime-tts-field="gptSoVitsConfig.volume"
      style="display:contents"
    >
      <SliderInput
        min={0.0}
        max={1.0}
        step={0.01}
        fixed={2}
        bind:value={
          () => read("gptSoVitsConfig", ["volume"], 0),
          (value) => write("gptSoVitsConfig", ["volume"], value, 0)
        }
      />
    </div>
    <span class="text-textcolor">URL</span>
    <div data-runtime-tts-field="gptSoVitsConfig.url" style="display:contents">
      <TextInput
        id="runtime-tts-gptSoVitsConfig.url"
        className="mb-4 mt-2"
        bind:value={
          () => read("gptSoVitsConfig", ["url"], ""),
          (value) => write("gptSoVitsConfig", ["url"], value, "")
        }
      />
    </div>

    <span class="text-textcolor">Use Auto Path</span>
    <div
      data-runtime-tts-field="gptSoVitsConfig.use_auto_path"
      style="display:contents"
    >
      <Check
        bind:check={
          () => read("gptSoVitsConfig", ["use_auto_path"], false),
          (value) => write("gptSoVitsConfig", ["use_auto_path"], value, false)
        }
      />
    </div>

    {#if !config("gptSoVitsConfig").use_auto_path}
      <span class="text-textcolor"
        >Reference Audio Path (e.g.
        C:/Users/user/Downloads/GPT-SoVITS-v2-240821)</span
      >
      <div
        data-runtime-tts-field="gptSoVitsConfig.ref_audio_path"
        style="display:contents"
      >
        <TextInput
          id="runtime-tts-gptSoVitsConfig.ref_audio_path"
          className="mb-4 mt-2"
          bind:value={
            () => read("gptSoVitsConfig", ["ref_audio_path"], ""),
            (value) => write("gptSoVitsConfig", ["ref_audio_path"], value, "")
          }
        />
      </div>
    {/if}

    <span class="text-textcolor">Use Long Audio</span>
    <div
      data-runtime-tts-field="gptSoVitsConfig.use_long_audio"
      style="display:contents"
    >
      <Check
        bind:check={
          () => read("gptSoVitsConfig", ["use_long_audio"], false),
          (value) => write("gptSoVitsConfig", ["use_long_audio"], value, false)
        }
      />
    </div>

    <span class="text-textcolor">Reference Audio Data (3~10s audio file)</span>
    <Button onclick={selectReferenceAudio} className="h-10">
      {#if config("gptSoVitsConfig").ref_audio_data.assetId === "" || config("gptSoVitsConfig").ref_audio_data.assetId === undefined}
        {language.selectFile}
      {:else}
        {config("gptSoVitsConfig").ref_audio_data.fileName}
      {/if}
    </Button>
    <span class="text-textcolor">Text Language</span>
    <div
      data-runtime-tts-field="gptSoVitsConfig.text_lang"
      style="display:contents"
    >
      <SelectInput
        className="mb-4 mt-2"
        bind:value={
          () => read("gptSoVitsConfig", ["text_lang"], ""),
          (value) => write("gptSoVitsConfig", ["text_lang"], value, "")
        }
      >
        <OptionInput value="auto">Multi-language Mixed</OptionInput>
        <OptionInput value="auto_yue"
          >Multi-language Mixed (Cantonese)</OptionInput
        >
        <OptionInput value="en">English</OptionInput>
        <OptionInput value="zh">Chinese-English Mixed</OptionInput>
        <OptionInput value="ja">Japanese-English Mixed</OptionInput>
        <OptionInput value="yue">Cantonese-English Mixed</OptionInput>
        <OptionInput value="ko">Korean-English Mixed</OptionInput>
        <OptionInput value="all_zh">Chinese</OptionInput>
        <OptionInput value="all_ja">Japanese</OptionInput>
        <OptionInput value="all_yue">Cantonese</OptionInput>
        <OptionInput value="all_ko">Korean</OptionInput>
      </SelectInput>
    </div>

    {#if !config("gptSoVitsConfig").use_long_audio}
      <span class="text-textcolor">Use Reference Audio Script</span>
      <div
        data-runtime-tts-field="gptSoVitsConfig.use_prompt"
        style="display:contents"
      >
        <Check
          bind:check={
            () => read("gptSoVitsConfig", ["use_prompt"], false),
            (value) => write("gptSoVitsConfig", ["use_prompt"], value, false)
          }
        />
      </div>
    {/if}

    {#if config("gptSoVitsConfig").use_prompt && !config("gptSoVitsConfig").use_long_audio}
      <span class="text-textcolor">Reference Audio Script</span>
      <div
        data-runtime-tts-field="gptSoVitsConfig.prompt"
        style="display:contents"
      >
        <TextAreaInput
          id="runtime-tts-gptSoVitsConfig.prompt"
          className="mb-4 mt-2"
          bind:value={
            () => read("gptSoVitsConfig", ["prompt"], ""),
            (value) => write("gptSoVitsConfig", ["prompt"], value, "")
          }
        />
      </div>
    {/if}

    <span class="text-textcolor">Reference Audio Language</span>
    <div
      data-runtime-tts-field="gptSoVitsConfig.prompt_lang"
      style="display:contents"
    >
      <SelectInput
        className="mb-4 mt-2"
        bind:value={
          () => read("gptSoVitsConfig", ["prompt_lang"], ""),
          (value) => write("gptSoVitsConfig", ["prompt_lang"], value, "")
        }
      >
        <OptionInput value="auto">Multi-language Mixed</OptionInput>
        <OptionInput value="auto_yue"
          >Multi-language Mixed (Cantonese)</OptionInput
        >
        <OptionInput value="en">English</OptionInput>
        <OptionInput value="zh">Chinese-English Mixed</OptionInput>
        <OptionInput value="ja">Japanese-English Mixed</OptionInput>
        <OptionInput value="yue">Cantonese-English Mixed</OptionInput>
        <OptionInput value="ko">Korean-English Mixed</OptionInput>
        <OptionInput value="all_zh">Chinese</OptionInput>
        <OptionInput value="all_ja">Japanese</OptionInput>
        <OptionInput value="all_yue">Cantonese</OptionInput>
        <OptionInput value="all_ko">Korean</OptionInput>
      </SelectInput>
    </div>
    <span class="text-textcolor">Top P</span>
    <div
      data-runtime-tts-field="gptSoVitsConfig.top_p"
      style="display:contents"
    >
      <SliderInput
        min={0.0}
        max={1.0}
        step={0.05}
        fixed={2}
        bind:value={
          () => read("gptSoVitsConfig", ["top_p"], 0),
          (value) => write("gptSoVitsConfig", ["top_p"], value, 0)
        }
      />
    </div>

    <span class="text-textcolor">Temperature</span>
    <div
      data-runtime-tts-field="gptSoVitsConfig.temperature"
      style="display:contents"
    >
      <SliderInput
        min={0.0}
        max={1.0}
        step={0.05}
        fixed={2}
        bind:value={
          () => read("gptSoVitsConfig", ["temperature"], 0),
          (value) => write("gptSoVitsConfig", ["temperature"], value, 0)
        }
      />
    </div>

    <span class="text-textcolor">Speed</span>
    <div
      data-runtime-tts-field="gptSoVitsConfig.speed"
      style="display:contents"
    >
      <SliderInput
        min={0.6}
        max={1.65}
        step={0.05}
        fixed={2}
        bind:value={
          () => read("gptSoVitsConfig", ["speed"], 0),
          (value) => write("gptSoVitsConfig", ["speed"], value, 0)
        }
      />
    </div>

    <span class="text-textcolor">Top K</span>
    <div
      data-runtime-tts-field="gptSoVitsConfig.top_k"
      style="display:contents"
    >
      <SliderInput
        min={1}
        max={100}
        step={1}
        bind:value={
          () => read("gptSoVitsConfig", ["top_k"], 0),
          (value) => write("gptSoVitsConfig", ["top_k"], value, 0)
        }
      />
    </div>

    <span class="text-textcolor">Text Split Method</span>
    <div
      data-runtime-tts-field="gptSoVitsConfig.text_split_method"
      style="display:contents"
    >
      <SelectInput
        className="mb-4 mt-2"
        bind:value={
          () => read("gptSoVitsConfig", ["text_split_method"], ""),
          (value) => write("gptSoVitsConfig", ["text_split_method"], value, "")
        }
      >
        <OptionInput value="cut0">Cut 0 (No splitting)</OptionInput>
        <OptionInput value="cut1">Cut 1 (Split every 4 sentences)</OptionInput>
        <OptionInput value="cut2">Cut 2 (Split every 50 characters)</OptionInput
        >
        <OptionInput value="cut3">Cut 3 (Split by Chinese periods)</OptionInput>
        <OptionInput value="cut4">Cut 4 (Split by English periods)</OptionInput>
        <OptionInput value="cut5"
          >Cut 5 (Split by various punctuation marks)</OptionInput
        >
      </SelectInput>
    </div>
  {:else if values.ttsMode === "fishspeech"}
    {#await getFishSpeechModels()}
      <span class="text-textcolor">Loading...</span>
    {:then}
      <span class="text-textcolor">Model</span>
      <div
        data-runtime-tts-field="fishSpeechConfig.model._id"
        style="display:contents"
      >
        <SelectInput
          className="mb-4 mt-2"
          bind:value={
            () => read("fishSpeechConfig", ["model", "_id"], ""),
            (value) => write("fishSpeechConfig", ["model", "_id"], value, "")
          }
        >
          <OptionInput value="">Not selected</OptionInput>
          {#each fishSpeechModels as model}
            <OptionInput value={model._id}>
              <div class="flex items-center">
                <span>{model.title}</span>
                <span class="text-sm text-textcolor2">{model.description}</span>
              </div>
            </OptionInput>
          {/each}
        </SelectInput>
      </div>
    {:catch}
      <span class="text-textcolor"
        >An error occurred while fetching the models.</span
      >
    {/await}

    <span class="text-textcolor">Chunk Length</span>
    <div
      data-runtime-tts-field="fishSpeechConfig.chunk_length"
      style="display:contents"
    >
      <NumberInput
        id="runtime-tts-fishSpeechConfig.chunk_length"
        className="mb-4 mt-2"
        bind:value={
          () => read("fishSpeechConfig", ["chunk_length"], 0),
          (value) => write("fishSpeechConfig", ["chunk_length"], value, 0)
        }
      />
    </div>

    <span class="mt-2 text-textcolor">Normalize</span>
    <div
      data-runtime-tts-field="fishSpeechConfig.normalize"
      style="display:contents"
    >
      <Check
        className="mb-4 mt-2"
        bind:check={
          () => read("fishSpeechConfig", ["normalize"], false),
          (value) => write("fishSpeechConfig", ["normalize"], value, false)
        }
      />
    </div>
  {/if}
  {#if values.ttsMode}
    <div class="flex items-center mt-2">
      <div data-runtime-tts-field="ttsReadOnlyQuoted" style="display:contents">
        <Check
          bind:check={
            () => read("ttsReadOnlyQuoted", [], false),
            (value) => write("ttsReadOnlyQuoted", [], value, false)
          }
          name={language.ttsReadOnlyQuoted}
        />
      </div>
    </div>
  {/if}
</div>
