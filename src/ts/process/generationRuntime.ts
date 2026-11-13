import { get, type Writable } from "svelte/store";
import type {
  character,
  MessageGenerationInfo,
  Chat,
  MessagePresetInfo,
  changeToPreset,
  setCurrentChat,
  Message,
  StreamingDisplayOptimizationMode,
} from "../storage/database.svelte";
import type { DBState } from "../stores.svelte";
import type { CharEmotion, selectedCharID } from "../stores.svelte";
import type { ChatTokenizer, tokenize, tokenizeNum } from "../tokenizer";
import type { language } from "../../lang";
import type { alertError, alertToast } from "../alert";
import type { parseChatML } from "../parser/chatML";
import type { loadLoreBookV3Prompt } from "./lorebook.svelte";
import type {
  findCharacterbyId,
  getAuthorNoteDefaultText,
  getPersonaPrompt,
  getUserName,
  isLastCharPunctuation,
  trimUntilPunctuation,
  parseToggleSyntax,
  prebuiltAssetCommand,
} from "../util";
import type { requestChatData } from "./request/request";
import type { stableDiff } from "./stableDiff";
import type {
  processScript,
  processScriptFull,
  risuChatParser,
} from "./scripts";
import type { exampleMessage } from "./exampleMessages";
import type { sayTTS } from "./tts";
import type { supaMemory } from "./memory/supaMemory";
import type { v4 } from "uuid";
import type { groupOrder } from "./group";
import type { runTrigger } from "./triggers";
import type { HypaProcesser } from "./memory/hypamemory";
import type { additionalInformations } from "./embedding/addinfo";
import type { getInlayAsset } from "./files/inlays";
import type { getGenerationModelString } from "./models/modelString";
import type {
  connectionOpen,
  peerRevertChat,
  peerSafeCheck,
  peerSync,
} from "../sync/multiuser";
import type { runInlayScreen } from "./inlayScreen";
import type { addRerolls } from "./prereroll";
import type { runImageEmbedding } from "./transformers";
import type { hanuraiMemory } from "./memory/hanuraiMemory";
import type { hypaMemoryV2 } from "./memory/hypav2";
import type { runLuaEditTrigger } from "./scriptings";
import type { getModelInfo, LLMFlags } from "../model/modellist";
import type { hypaMemoryV3 } from "./memory/hypav3";
import type { getModuleAssets, getModuleToggles } from "./modules";
import type { readImage } from "../globalApi.svelte";
import type { pluginV2 } from "../plugins/plugins.svelte";

export interface OpenAIChat {
  role: "system" | "user" | "assistant" | "function";
  content: string;
  memo?: string;
  name?: string;
  removable?: boolean;
  attr?: string[];
  multimodals?: MultiModal[];
  thoughts?: string[];
  cachePoint?: boolean;
}

export interface MultiModal {
  type: "image" | "video" | "audio" | "signature";
  base64: string;
  height?: number;
  width?: number;
}

export interface requestTokenPart {
  name: string;
  tokens: number;
}

/** Native/browser-neutral upstream generation algorithm. All state and capabilities are explicit ports. */
export interface GenerationRuntimeHost {
  readGlobalVariable: (key: string) => string;
  incrementMessageCount: () => void;
  recordCharacterInteraction: (
    character: character | import("../storage/database.svelte").groupChat,
    timestamp: number,
  ) => void;
  changeToPreset: (typeof import("../storage/database.svelte"))["changeToPreset"];
  setCurrentChat: (typeof import("../storage/database.svelte"))["setCurrentChat"];
  DBState: (typeof import("../stores.svelte"))["DBState"];
  CharEmotion: (typeof import("../stores.svelte"))["CharEmotion"];
  selectedCharID: (typeof import("../stores.svelte"))["selectedCharID"];
  ChatTokenizer: (typeof import("../tokenizer"))["ChatTokenizer"];
  tokenize: (typeof import("../tokenizer"))["tokenize"];
  tokenizeNum: (typeof import("../tokenizer"))["tokenizeNum"];
  language: (typeof import("../../lang"))["language"];
  alertError: (typeof import("../alert"))["alertError"];
  alertToast: (typeof import("../alert"))["alertToast"];
  parseChatML: (typeof import("../parser/chatML"))["parseChatML"];
  loadLoreBookV3Prompt: (typeof import("./lorebook.svelte"))["loadLoreBookV3Prompt"];
  findCharacterbyId: (typeof import("../util"))["findCharacterbyId"];
  getAuthorNoteDefaultText: (typeof import("../util"))["getAuthorNoteDefaultText"];
  getPersonaPrompt: (typeof import("../util"))["getPersonaPrompt"];
  getUserName: (typeof import("../util"))["getUserName"];
  isLastCharPunctuation: (typeof import("../util"))["isLastCharPunctuation"];
  trimUntilPunctuation: (typeof import("../util"))["trimUntilPunctuation"];
  parseToggleSyntax: (typeof import("../util"))["parseToggleSyntax"];
  prebuiltAssetCommand: (typeof import("../util"))["prebuiltAssetCommand"];
  requestChatData: (typeof import("./request/request"))["requestChatData"];
  stableDiff: (typeof import("./stableDiff"))["stableDiff"];
  processScript: (typeof import("./scripts"))["processScript"];
  processScriptFull: (typeof import("./scripts"))["processScriptFull"];
  risuChatParser: (typeof import("./scripts"))["risuChatParser"];
  exampleMessage: (typeof import("./exampleMessages"))["exampleMessage"];
  sayTTS: (typeof import("./tts"))["sayTTS"];
  supaMemory: (typeof import("./memory/supaMemory"))["supaMemory"];
  v4: (typeof import("uuid"))["v4"];
  groupOrder: (typeof import("./group"))["groupOrder"];
  runTrigger: (typeof import("./triggers"))["runTrigger"];
  HypaProcesser: (typeof import("./memory/hypamemory"))["HypaProcesser"];
  additionalInformations: (typeof import("./embedding/addinfo"))["additionalInformations"];
  getInlayAsset: (typeof import("./files/inlays"))["getInlayAsset"];
  getGenerationModelString: (typeof import("./models/modelString"))["getGenerationModelString"];
  connectionOpen: (typeof import("../sync/multiuser"))["connectionOpen"];
  peerRevertChat: (typeof import("../sync/multiuser"))["peerRevertChat"];
  peerSafeCheck: (typeof import("../sync/multiuser"))["peerSafeCheck"];
  peerSync: (typeof import("../sync/multiuser"))["peerSync"];
  runInlayScreen: (typeof import("./inlayScreen"))["runInlayScreen"];
  addRerolls: (typeof import("./prereroll"))["addRerolls"];
  runImageEmbedding: (typeof import("./transformers"))["runImageEmbedding"];
  hanuraiMemory: (typeof import("./memory/hanuraiMemory"))["hanuraiMemory"];
  hypaMemoryV2: (typeof import("./memory/hypav2"))["hypaMemoryV2"];
  runLuaEditTrigger: (typeof import("./scriptings"))["runLuaEditTrigger"];
  getModelInfo: (typeof import("../model/modellist"))["getModelInfo"];
  LLMFlags: (typeof import("../model/modellist"))["LLMFlags"];
  hypaMemoryV3: (typeof import("./memory/hypav3"))["hypaMemoryV3"];
  getModuleAssets: (typeof import("./modules"))["getModuleAssets"];
  getModuleToggles: (typeof import("./modules"))["getModuleToggles"];
  readImage: (typeof import("../globalApi.svelte"))["readImage"];
  pluginV2: (typeof import("../plugins/plugins.svelte"))["pluginV2"];
  doingChat: Writable<boolean>;
  chatProcessStage: Writable<number>;
  abortChat: Writable<boolean>;
  requestTokenParts: { [key: string]: requestTokenPart[] };
  previewFormated: OpenAIChat[];
  previewBody: string;
  snapshot: (value: unknown) => unknown;
  safeStructuredClone: <T>(value: T) => T;
  requestAnimationFrame: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame: (id: number) => void;
  notify: (text: string) => Promise<void>;
}

export function createGenerationRuntime(host: GenerationRuntimeHost) {
  function findMessageIndexByChatId(chat: Chat, chatId?: string) {
    if (!chatId) {
      return -1;
    }
    return chat.message.findIndex((message) => message.chatId === chatId);
  }

  async function runChatOutputListeners(
    char: any,
    chat: any,
    characterIndex: number,
    chatIndex: number,
    messageIndex: number,
  ) {
    if (host.pluginV2.chatOutput.size === 0) {
      return;
    }
    const charSnapshot = host.snapshot(char);
    const chatSnapshot = host.snapshot(chat);
    for (const listener of host.pluginV2.chatOutput) {
      try {
        await listener({
          char: charSnapshot,
          chat: chatSnapshot,
          characterIndex,
          chatIndex,
          messageIndex,
        });
      } catch (e) {
        console.error(e);
      }
    }
  }

  async function sendChat(
    chatProcessIndex = -1,
    arg: {
      chatAdditonalTokens?: number;
      signal?: AbortSignal;
      continue?: boolean;
      usedContinueTokens?: number;
      preview?: boolean;
      previewPrompt?: boolean;
    } = {},
  ): Promise<boolean> {
    host.chatProcessStage.set(0);
    const abortSignal = arg.signal ?? new AbortController().signal;
    // NOTE: `throwError()` can be called before these are populated (e.g. HypaV3 early validation errors).
    // Keep them declared up-front to avoid TDZ ReferenceErrors in production builds.
    let selectedChar = -1;
    let selectedChat = -1;
    let currentChar: character;
    let generationInfo: MessageGenerationInfo | undefined = undefined;
    const stageTimings = {
      stage1Start: 0,
      stage2Start: 0,
      stage3Start: 0,
      stage4Start: 0,
      stage1Duration: 0,
      stage2Duration: 0,
      stage3Duration: 0,
      stage4Duration: 0,
    };
    let isAborted = false;
    let findCharCache: {
      [key: string]: character;
    } = {};
    function findCharacterbyIdwithCache(id: string) {
      const d = findCharCache[id];
      if (!!d) {
        return d;
      } else {
        const r = host.findCharacterbyId(id);
        findCharCache[id] = r;
        return r;
      }
    }
    function runCurrentChatFunction(chat: Chat) {
      chat.message = chat.message.map((v) => {
        v.data = host.risuChatParser(v.data, {
          chara: currentChar,
          runVar: true,
        });
        return v;
      });
      return chat;
    }
    function reformatContent(data: string) {
      if (chatProcessIndex === -1) {
        return data.trim();
      }
      return data.trim();
    }
    function throwError(error: string) {
      if (!host.DBState?.db?.inlayErrorResponse) {
        host.alertError(error);
        return;
      }
      try {
        const db = host.DBState.db;
        // Prefer already-resolved selection, but fall back to current store/db pointers.
        const sc = selectedChar >= 0 ? selectedChar : get(host.selectedCharID);
        const charRoom = db.characters?.[sc];
        if (!charRoom) {
          host.alertError(error);
          return;
        }
        const st = selectedChat >= 0 ? selectedChat : charRoom.chatPage;
        const chatRoom = charRoom.chats?.[st];
        if (!chatRoom || !Array.isArray(chatRoom.message)) {
          host.alertError(error);
          return;
        }
        const messages = chatRoom.message;
        const last = messages[messages.length - 1];
        const suffix = `\n\`\`\`risuerror\n${error}\n\`\`\``;
        if (last?.role === "char") {
          last.data += suffix;
          return;
        }
        const m: Message = {
          role: "char",
          data: `\`\`\`risuerror\n${error}\n\`\`\``,
          time: Date.now(),
        };
        if (currentChar?.chaId) {
          m.saying = currentChar.chaId;
        }
        if (generationInfo) {
          m.generationInfo = generationInfo;
        }
        messages.push(m);
        return;
      } catch (e) {
        console.error(e);
        host.alertError(error);
        return;
      }
    }
    let isDoing = get(host.doingChat);
    if (isDoing) {
      if (chatProcessIndex === -1) {
        return false;
      }
    }
    host.doingChat.set(true);
    if (chatProcessIndex === -1 && host.DBState.db.presetChain) {
      const names = host.DBState.db.presetChain.split(",").map((v) => v.trim());
      const randomSelect = Math.floor(Math.random() * names.length);
      const ele = names[randomSelect];
      const findId = host.DBState.db.botPresets.findIndex((v) => {
        return v.name === ele;
      });
      if (findId === -1) {
        host.alertToast(`Cannot find preset: ${ele}`);
      } else {
        host.changeToPreset(findId, true);
      }
    }
    if (host.connectionOpen) {
      host.chatProcessStage.set(4);
      const peerSafe = await host.peerSafeCheck();
      if (!peerSafe) {
        host.peerRevertChat();
        host.doingChat.set(false);
        throwError(host.language.otherUserRequesting);
        return false;
      }
      await host.peerSync();
      host.chatProcessStage.set(0);
    }
    host.incrementMessageCount();
    selectedChar = get(host.selectedCharID);
    const nowChatroom = host.DBState.db.characters[selectedChar];
    host.recordCharacterInteraction(nowChatroom, Date.now());
    selectedChat = nowChatroom.chatPage;
    nowChatroom.chats[nowChatroom.chatPage].message = nowChatroom.chats[
      nowChatroom.chatPage
    ].message.map((v) => {
      v.chatId = v.chatId ?? host.v4();
      return v;
    });
    let promptInfo: MessagePresetInfo = {};
    let initialPresetNameForPromptInfo = null;
    let initialPromptTogglesForPromptInfo: {
      key: string;
      value: string;
    }[] = [];
    if (host.DBState.db.promptInfoInsideChat) {
      initialPresetNameForPromptInfo =
        host.DBState.db.botPresets[host.DBState.db.botPresetsId]?.name ?? "";
      initialPromptTogglesForPromptInfo = host
        .parseToggleSyntax(
          host.DBState.db.customPromptTemplateToggle + host.getModuleToggles(),
        )
        .flatMap((toggle) => {
          const raw = host.readGlobalVariable(`toggle_${toggle.key}`);
          if (toggle.type === "select" || toggle.type === "text") {
            return [{ key: toggle.value, value: toggle.options[raw] }];
          }
          if (raw === "1") {
            return [{ key: toggle.value, value: "ON" }];
          }
          return [];
        });
      promptInfo = {
        promptName: initialPresetNameForPromptInfo,
        promptToggles: initialPromptTogglesForPromptInfo,
      };
    }
    let caculatedChatTokens = 0;
    if (host.DBState.db.aiModel.startsWith("gpt")) {
      caculatedChatTokens += 5;
    } else {
      caculatedChatTokens += 3;
    }
    if (nowChatroom.type === "group") {
      if (chatProcessIndex === -1) {
        const charNames = nowChatroom.characters.map(
          (v) => findCharacterbyIdwithCache(v).name,
        );
        const messages = nowChatroom.chats[nowChatroom.chatPage].message;
        const lastMessage = messages[messages.length - 1];
        let order = nowChatroom.characters
          .map((v, i) => {
            return {
              id: v,
              talkness: nowChatroom.characterActive[i]
                ? nowChatroom.characterTalks[i]
                : -1,
              index: i,
            };
          })
          .filter((v) => {
            return v.talkness > 0;
          });
        if (!nowChatroom.orderByOrder) {
          order = host.groupOrder(order, lastMessage?.data).filter((v) => {
            if (v.id === lastMessage?.saying) {
              return false;
            }
            return true;
          });
        }
        for (let i = 0; i < order.length; i++) {
          const r = await sendChat(order[i].index, {
            chatAdditonalTokens: caculatedChatTokens,
            signal: abortSignal,
          });
          if (!r) {
            return false;
          }
        }
        return true;
      } else {
        currentChar = findCharacterbyIdwithCache(
          nowChatroom.characters[chatProcessIndex],
        );
        if (!currentChar) {
          throwError(
            `cannot find character: ${nowChatroom.characters[chatProcessIndex]}`,
          );
          return false;
        }
      }
    } else {
      currentChar = nowChatroom;
    }
    let chatAdditonalTokens = arg.chatAdditonalTokens ?? caculatedChatTokens;
    const tokenizer = new host.ChatTokenizer(
      chatAdditonalTokens,
      host.DBState.db.aiModel.startsWith("gpt") ? "noName" : "name",
    );
    let currentChat = runCurrentChatFunction(nowChatroom.chats[selectedChat]);
    nowChatroom.chats[selectedChat] = currentChat;
    let maxContextTokens = host.DBState.db.maxContext;
    host.chatProcessStage.set(1);
    stageTimings.stage1Start = Date.now();
    let unformated = {
      main: [] as OpenAIChat[],
      jailbreak: [] as OpenAIChat[],
      chats: [] as OpenAIChat[],
      lorebook: [] as OpenAIChat[],
      globalNote: [] as OpenAIChat[],
      authorNote: [] as OpenAIChat[],
      lastChat: [] as OpenAIChat[],
      description: [] as OpenAIChat[],
      postEverything: [] as OpenAIChat[],
      personaPrompt: [] as OpenAIChat[],
    };
    let promptTemplate = host.safeStructuredClone(
      host.DBState.db.promptTemplate,
    );
    const usingPromptTemplate = !!promptTemplate;
    if (promptTemplate) {
      let hasPostEverything = false;
      for (const card of promptTemplate) {
        if (card.type === "postEverything") {
          hasPostEverything = true;
          break;
        }
      }
      if (!hasPostEverything) {
        promptTemplate.push({
          type: "postEverything",
        });
      }
    }
    if (
      currentChar.utilityBot &&
      !(usingPromptTemplate && host.DBState.db.promptSettings.utilOverride)
    ) {
      promptTemplate = [
        {
          type: "plain",
          text: "",
          role: "system",
          type2: "main",
        },
        {
          type: "description",
        },
        {
          type: "lorebook",
        },
        {
          type: "chat",
          rangeStart: 0,
          rangeEnd: "end",
        },
        {
          type: "plain",
          text: "",
          role: "system",
          type2: "globalNote",
        },
        {
          type: "postEverything",
        },
      ];
    }
    if (!currentChar.utilityBot && !promptTemplate) {
      const mainp =
        currentChar.systemPrompt?.replaceAll(
          "{{original}}",
          host.DBState.db.mainPrompt,
        ) || host.DBState.db.mainPrompt;
      function formatPrompt(data: string) {
        if (!data.startsWith("@@")) {
          data = "@@system\n" + data;
        }
        const parts = data.split(/@@@?(user|assistant|system)\n/);
        // Initialize empty array for the chat objects
        const chatObjects: OpenAIChat[] = [];
        // Loop through the parts array two elements at a time
        for (let i = 1; i < parts.length; i += 2) {
          const role = parts[i] as "user" | "assistant" | "system";
          const content = parts[i + 1]?.trim() || "";
          chatObjects.push({ role, content });
        }
        return chatObjects;
      }
      unformated.main.push(
        ...formatPrompt(
          host.risuChatParser(
            mainp +
              (host.DBState.db.additionalPrompt === "" ||
              !host.DBState.db.promptPreprocess
                ? ""
                : `\n${host.DBState.db.additionalPrompt}`),
            { chara: currentChar },
          ),
        ),
      );
      if (host.DBState.db.jailbreakToggle) {
        unformated.jailbreak.push(
          ...formatPrompt(
            host.risuChatParser(host.DBState.db.jailbreak, {
              chara: currentChar,
            }),
          ),
        );
      }
      unformated.globalNote.push(
        ...formatPrompt(
          host.risuChatParser(
            currentChar.replaceGlobalNote?.replaceAll(
              "{{original}}",
              host.DBState.db.globalNote,
            ) || host.DBState.db.globalNote,
            { chara: currentChar },
          ),
        ),
      );
    }
    let baseDescriptionPrompt: OpenAIChat | null = null;
    let beforeDescriptionPrompts: OpenAIChat[] = [];
    let afterDescriptionPrompts: OpenAIChat[] = [];
    if (currentChat.note) {
      unformated.authorNote.push({
        role: "system",
        content: host.risuChatParser(currentChat.note, { chara: currentChar }),
      });
    } else if (host.getAuthorNoteDefaultText() !== "") {
      unformated.authorNote.push({
        role: "system",
        content: host.risuChatParser(host.getAuthorNoteDefaultText(), {
          chara: currentChar,
        }),
      });
    }
    if (
      host.DBState.db.chainOfThought &&
      !(
        usingPromptTemplate &&
        host.DBState.db.promptSettings.customChainOfThought
      )
    ) {
      unformated.postEverything.push({
        role: "system",
        content: `<instruction> - before respond everything, Think step by step as a ai assistant how would you respond inside <Thoughts> xml tag. this must be less than 5 paragraphs.</instruction>`,
      });
    }
    {
      let description = host.risuChatParser(
        (host.DBState.db.promptPreprocess
          ? host.DBState.db.descriptionPrefix
          : "") + currentChar.desc,
        { chara: currentChar },
      );
      const additionalInfo = await host.additionalInformations(
        currentChar,
        currentChat,
      );
      if (additionalInfo) {
        description +=
          "\n\n" + host.risuChatParser(additionalInfo, { chara: currentChar });
      }
      if (currentChar.personality) {
        description += host.risuChatParser(
          "\n\nDescription of {{char}}: " + currentChar.personality,
          { chara: currentChar },
        );
      }
      if (currentChar.scenario) {
        description += host.risuChatParser(
          "\n\nCircumstances and context of the dialogue: " +
            currentChar.scenario,
          { chara: currentChar },
        );
      }
      baseDescriptionPrompt = {
        role: "system",
        content: description,
      };
      unformated.description.push(baseDescriptionPrompt);
      if (nowChatroom.type === "group") {
        const systemMsg = `[Write the next reply only as ${currentChar.name}]`;
        unformated.postEverything.push({
          role: "system",
          content: systemMsg,
        });
      }
    }
    const lorepmt = await host.loadLoreBookV3Prompt();
    const positionRegex = /{{position::(.+?)}}/g;
    const replaceposition = (
      text: string,
    ): {
      text: string;
      replaced: boolean;
    } => {
      let replaced = false;
      const result = text.replace(positionRegex, (match, p1) => {
        replaced = true;
        const posMatch = "pt_" + p1;
        const matchingPrompts: string[] = [];
        for (const v of lorepmt.actives) {
          if (v.pos === posMatch) {
            matchingPrompts.push(v.prompt);
          }
        }
        return matchingPrompts.join("\n");
      });
      return { text: result, replaced };
    };
    // maxDepth controls how many levels of nesting are resolved. Currently set to 5, adjust if needed.
    const resolvePosition = (text: string, maxDepth: number = 5) => {
      let result = text;
      for (let i = 0; i < maxDepth; i++) {
        const r = replaceposition(result);
        result = r.text;
        if (!r.replaced) break;
      }
      result = result.replace(positionRegex, "");
      return result;
    };
    const normalActives = lorepmt.actives.filter((v) => {
      return v.pos === "" && v.inject === null;
    });
    console.log(normalActives);
    for (const lorebook of normalActives) {
      unformated.lorebook.push({
        role: lorebook.role,
        content: host.risuChatParser(resolvePosition(lorebook.prompt), {
          chara: currentChar,
        }),
      });
    }
    const descActives = lorepmt.actives.filter((v) => {
      return (
        v.pos === "after_desc" ||
        v.pos === "before_desc" ||
        v.pos === "personality" ||
        v.pos === "scenario"
      );
    });
    for (const lorebook of descActives) {
      const c = {
        role: lorebook.role,
        content: host.risuChatParser(resolvePosition(lorebook.prompt), {
          chara: currentChar,
        }),
      };
      if (lorebook.pos === "before_desc") {
        beforeDescriptionPrompts.unshift(c);
        unformated.description.unshift(c);
      } else {
        afterDescriptionPrompts.push(c);
        unformated.description.push(c);
      }
    }
    if (host.DBState.db.personaPrompt) {
      unformated.personaPrompt.push({
        role: "system",
        content: host.risuChatParser(host.getPersonaPrompt(), {
          chara: currentChar,
        }),
      });
    }
    if (currentChar.inlayViewScreen) {
      if (currentChar.viewScreen === "emotion") {
        unformated.postEverything.push({
          role: "system",
          content: currentChar.newGenData.emotionInstructions.replaceAll(
            "{{slot}}",
            currentChar.emotionImages.map((v) => v[0]).join(", "),
          ),
        });
      }
      if (currentChar.viewScreen === "imggen") {
        unformated.postEverything.push({
          role: "system",
          content: currentChar.newGenData.instructions,
        });
      }
    }
    const postEverythingLorebooks = lorepmt.actives.filter((v) => {
      return v.pos === "depth" && v.depth === 0 && v.role !== "assistant";
    });
    for (const lorebook of postEverythingLorebooks) {
      unformated.postEverything.push({
        role: lorebook.role,
        content: host.risuChatParser(resolvePosition(lorebook.prompt), {
          chara: currentChar,
        }),
      });
    }
    //Since assistant needs to be prefill, we need to add assistant lorebooks after user/system lorebooks
    const postEverythingAssistantLorebooks = lorepmt.actives.filter((v) => {
      return v.pos === "depth" && v.depth === 0 && v.role === "assistant";
    });
    const injectionLorebooks = lorepmt.actives.filter((v) => {
      return v.inject && !v.inject.lore;
    });
    const injectionLorePosSet = new Set<string>();
    for (const lorebook of injectionLorebooks) {
      injectionLorePosSet.add(lorebook.inject.location);
    }
    for (const lorebook of postEverythingAssistantLorebooks) {
      unformated.postEverything.push({
        role: lorebook.role,
        content: host.risuChatParser(resolvePosition(lorebook.prompt), {
          chara: currentChar,
        }),
      });
    }
    //await tokenize currernt
    let currentTokens = host.DBState.db.maxResponse;
    let supaMemoryCardUsed = false;
    //for unexpected error
    currentTokens += 50;
    const positionParser = (text: string, loc: string) => {
      console.log(injectionLorePosSet);
      if (injectionLorePosSet.has(loc)) {
        const matchings = injectionLorebooks.filter((v) => {
          return v.inject.location === loc;
        });
        for (const lore of matchings) {
          switch (lore.inject.operation) {
            case "append": {
              text += " " + lore.prompt;
              break;
            }
            case "prepend": {
              text = lore.prompt + " " + text;
              break;
            }
            case "replace": {
              text = text.replace(lore.inject.param, lore.prompt);
              break;
            }
          }
        }
      }
      return resolvePosition(text);
    };
    let hasCachePoint = false;
    const convertPromptRole = {
      system: "system",
      user: "user",
      bot: "assistant",
    } as const;
    function applyPromptBlockRole(
      chats: OpenAIChat[],
      role?: "user" | "bot" | "system",
    ) {
      console.log("Applying ", chats, role);
      if (!role) {
        return;
      }
      for (const chat of chats) {
        chat.role = convertPromptRole[role];
      }
    }
    function getDescriptionPrompts(role?: "user" | "bot" | "system") {
      const pmt = [
        ...host.safeStructuredClone(beforeDescriptionPrompts),
        ...(baseDescriptionPrompt
          ? [host.safeStructuredClone(baseDescriptionPrompt)]
          : []),
        ...host.safeStructuredClone(afterDescriptionPrompts),
      ];
      if (baseDescriptionPrompt) {
        applyPromptBlockRole([pmt[beforeDescriptionPrompts.length]], role);
      }
      return pmt;
    }
    if (promptTemplate) {
      const template = promptTemplate;
      async function tokenizeChatArray(chats: OpenAIChat[]) {
        for (const chat of chats) {
          const tokens = await tokenizer.tokenizeChat(chat);
          currentTokens += tokens;
        }
      }
      for (const card of template) {
        switch (card.type) {
          case "persona": {
            let pmt = host.safeStructuredClone(unformated.personaPrompt);
            applyPromptBlockRole(pmt, card.role2);
            if (card.innerFormat && pmt.length > 0) {
              for (let i = 0; i < pmt.length; i++) {
                pmt[i].content = host
                  .risuChatParser(positionParser(card.innerFormat, card.type), {
                    chara: currentChar,
                  })
                  .replace("{{slot}}", pmt[i].content);
              }
            }
            await tokenizeChatArray(pmt);
            break;
          }
          case "description": {
            let pmt = getDescriptionPrompts(card.role2);
            if (card.innerFormat && pmt.length > 0) {
              for (let i = 0; i < pmt.length; i++) {
                pmt[i].content = host
                  .risuChatParser(positionParser(card.innerFormat, card.type), {
                    chara: currentChar,
                  })
                  .replace("{{slot}}", pmt[i].content);
              }
            }
            await tokenizeChatArray(pmt);
            break;
          }
          case "authornote": {
            let pmt = host.safeStructuredClone(unformated.authorNote);
            applyPromptBlockRole(pmt, card.role2);
            if (card.innerFormat && pmt.length > 0) {
              for (let i = 0; i < pmt.length; i++) {
                pmt[i].content = host
                  .risuChatParser(positionParser(card.innerFormat, card.type), {
                    chara: currentChar,
                  })
                  .replace(
                    "{{slot}}",
                    pmt[i].content || card.defaultText || "",
                  );
              }
            }
            await tokenizeChatArray(pmt);
            break;
          }
          case "lorebook": {
            await tokenizeChatArray(unformated.lorebook);
            break;
          }
          case "postEverything": {
            await tokenizeChatArray(unformated.postEverything);
            if (
              usingPromptTemplate &&
              host.DBState.db.promptSettings.postEndInnerFormat
            ) {
              await tokenizeChatArray([
                {
                  role: "system",
                  content: host.DBState.db.promptSettings.postEndInnerFormat,
                },
              ]);
            }
            break;
          }
          case "plain":
          case "jailbreak":
          case "cot": {
            if (!host.DBState.db.jailbreakToggle && card.type === "jailbreak") {
              continue;
            }
            if (!host.DBState.db.chainOfThought && card.type === "cot") {
              continue;
            }
            const posType = card.type === "plain" ? card.type2 : card.type;
            let content = positionParser(card.text, posType);
            if (card.type2 === "globalNote") {
              if (currentChar.replaceGlobalNote) {
                content = positionParser(
                  currentChar.replaceGlobalNote,
                  posType,
                ).replaceAll("{{original}}", content);
              }
              if (
                currentChar.prebuiltAssetCommand &&
                !card.text.includes("{{//@customimageinstruction}}")
              ) {
                content += host.prebuiltAssetCommand;
              }
              content = host.risuChatParser(content, {
                chara: currentChar,
                role: card.role,
              });
            } else if (card.type2 === "main") {
              content = host.risuChatParser(content, {
                chara: currentChar,
                role: card.role,
              });
            } else {
              content = host.risuChatParser(content, {
                chara: currentChar,
                role: card.role,
              });
            }
            const prompt: OpenAIChat = {
              role: convertPromptRole[card.role],
              content: content,
            };
            await tokenizeChatArray([prompt]);
            break;
          }
          case "chatML": {
            let prompts = host.parseChatML(card.text);
            await tokenizeChatArray(prompts);
            break;
          }
          case "chat": {
            let start = card.rangeStart;
            let end =
              card.rangeEnd === "end" ? unformated.chats.length : card.rangeEnd;
            if (start === -1000) {
              start = 0;
              end = unformated.chats.length;
            }
            if (start < 0) {
              start = unformated.chats.length + start;
              if (start < 0) {
                start = 0;
              }
            }
            if (end < 0) {
              end = unformated.chats.length + end;
              if (end < 0) {
                end = 0;
              }
            }
            if (start >= end) {
              break;
            }
            let chats = unformated.chats.slice(start, end);
            if (
              usingPromptTemplate &&
              host.DBState.db.promptSettings.sendChatAsSystem &&
              !card.chatAsOriginalOnSystem
            ) {
              chats = systemizeChat(chats);
            }
            await tokenizeChatArray(chats);
            break;
          }
          case "memory": {
            supaMemoryCardUsed = true;
            break;
          }
          case "cache": {
            hasCachePoint = true;
            break;
          }
        }
      }
    } else {
      for (const key in unformated) {
        const chats = unformated[key] as OpenAIChat[];
        for (const chat of chats) {
          currentTokens += await tokenizer.tokenizeChat(chat);
        }
      }
    }
    const examples = host.exampleMessage(currentChar, host.getUserName());
    for (const example of examples) {
      currentTokens += await tokenizer.tokenizeChat(example);
    }
    let chats: OpenAIChat[] = examples;
    if (
      !host.DBState.db.aiModel.startsWith("novelai") &&
      !host.DBState.db?.promptSettings?.trimStartNewChat
    ) {
      chats.push({
        role: "system",
        content: "[Start a new chat]",
        memo: "NewChat",
      });
    }
    let msReseted = false;
    const makeMs = (currentChat: Chat) => {
      let mss: Message[] = [];
      msReseted = false;
      for (let i = currentChat.message.length - 1; i >= 0; i--) {
        const d = currentChat.message[i];
        if (d.disabled === true) {
          continue;
        }
        if (d.disabled === "allBefore") {
          msReseted = true;
          break;
        }
        mss.unshift(d);
      }
      return mss;
    };
    let ms: Message[] = makeMs(currentChat);
    if (nowChatroom.type !== "group" && !msReseted) {
      const firstMsg =
        currentChat.fmIndex === -1
          ? nowChatroom.firstMessage
          : nowChatroom.alternateGreetings[currentChat.fmIndex];
      const chat: OpenAIChat = {
        role: "assistant",
        content: await host.processScript(
          nowChatroom,
          host.risuChatParser(firstMsg, { chara: currentChar }),
          "editprocess",
        ),
      };
      if (usingPromptTemplate && host.DBState.db.promptSettings.sendName) {
        chat.content = `${currentChar.name}: ${chat.content}`;
        chat.attr = ["nameAdded"];
      }
      chats.push(chat);
      currentTokens += await tokenizer.tokenizeChat(chat);
    }
    console.log("Prepared messages for token calculation:", ms);
    const triggerResult = await host.runTrigger(currentChar, "start", {
      chat: currentChat,
    });
    if (triggerResult) {
      currentChat = triggerResult.chat;
      host.setCurrentChat(currentChat);
      ms = makeMs(currentChat);
      currentTokens += triggerResult.tokens;
      if (triggerResult.stopSending) {
        host.doingChat.set(false);
        return false;
      }
    }
    let index = 0;
    for (const msg of ms) {
      let formatedChat = (
        await host.processScriptFull(
          nowChatroom,
          host.risuChatParser(msg.data, { chara: currentChar, role: msg.role }),
          "editprocess",
          index,
          {
            chatRole: msg.role,
          },
        )
      ).data;
      let name = "";
      if (msg.role === "char") {
        if (msg.saying) {
          name = `${findCharacterbyIdwithCache(msg.saying).name}`;
        } else {
          name = `${currentChar.name}`;
        }
      } else if (msg.role === "user") {
        name = `${host.getUserName()}`;
      }
      if (!msg.chatId) {
        msg.chatId = host.v4();
      }
      let inlays: string[] = [];
      if (msg.role === "char") {
        formatedChat = formatedChat.replace(
          /{{(inlay|inlayed|inlayeddata)::(.+?)}}/g,
          (match: string, p1: string, p2: string) => {
            if (p2 && p1 === "inlayeddata") {
              inlays.push(p2);
            }
            return "";
          },
        );
      } else {
        const inlayMatch = formatedChat.match(
          /{{(inlay|inlayed|inlayeddata)::(.+?)}}/g,
        );
        if (inlayMatch) {
          for (const inlay of inlayMatch) {
            inlays.push(inlay);
          }
        }
      }
      let multimodal: MultiModal[] = [];
      const modelinfo = host.getModelInfo(host.DBState.db.aiModel);
      if (inlays.length > 0) {
        for (const inlay of inlays) {
          const inlayName = inlay
            .replace("{{inlayed::", "")
            .replace("{{inlay::", "")
            .replace("}}", "")
            .replace("{{inlayeddata::", "");
          const inlayData = await host.getInlayAsset(inlayName);
          if (inlayData?.type === "image") {
            if (modelinfo.flags.includes(host.LLMFlags.hasImageInput)) {
              multimodal.push({
                type: "image",
                base64: inlayData.data,
                width: inlayData.width,
                height: inlayData.height,
              });
            } else {
              const captionResult = await host.runImageEmbedding(
                inlayData.data,
              );
              formatedChat += `[${captionResult[0].generated_text}]`;
            }
          }
          if (inlayData?.type === "video" || inlayData?.type === "audio") {
            if (multimodal.length === 0) {
              multimodal.push({
                type: inlayData.type,
                base64: inlayData.data,
              });
            }
          }
          if (inlayData?.type === "signature") {
            multimodal.push({
              type: "signature",
              base64: inlayData.data,
            });
          }
          formatedChat = formatedChat.replace(inlay, "");
        }
      }
      let attr: string[] = [];
      let role: "user" | "assistant" | "system" =
        msg.role === "user" ? "user" : "assistant";
      if (
        (nowChatroom.type === "group" &&
          findCharacterbyIdwithCache(msg.saying).chaId !== currentChar.chaId) ||
        (nowChatroom.type === "group" &&
          host.DBState.db.groupOtherBotRole === "assistant") ||
        (usingPromptTemplate && host.DBState.db.promptSettings.sendName)
      ) {
        const form =
          host.DBState.db.groupTemplate ||
          `<{{char}}\'s Message>\n{{slot}}\n</{{char}}\'s Message>`;
        formatedChat = host
          .risuChatParser(form, {
            chara: findCharacterbyIdwithCache(msg.saying).name,
          })
          .replace("{{slot}}", formatedChat);
        switch (host.DBState.db.groupOtherBotRole) {
          case "user":
          case "assistant":
          case "system":
            role = host.DBState.db.groupOtherBotRole;
            break;
          default:
            role = "assistant";
            break;
        }
      }
      let thoughts: string[] = [];
      const maxThoughtDepth =
        host.DBState.db.promptSettings?.maxThoughtTagDepth ?? -1;
      formatedChat = formatedChat.replace(
        /<Thoughts>(.+)<\/Thoughts>/gms,
        (match, p1) => {
          if (maxThoughtDepth === -1 || maxThoughtDepth - ms.length <= index) {
            thoughts.push(p1);
          }
          return "";
        },
      );
      const assetPromises: Promise<void>[] = [];
      formatedChat = formatedChat.replace(
        /\{\{asset_?prompt::(.+?)\}\}/gimsu,
        (match, p1) => {
          const moduleAssets = host.getModuleAssets();
          const assets = (currentChar.additionalAssets ?? []).concat(
            moduleAssets,
          );
          const asset = assets.find((v) => {
            return v[0] === p1;
          });
          if (asset) {
            assetPromises.push(
              (async () => {
                const assetDataBuf = await host.readImage(asset[1]);
                multimodal.push({
                  type: "image",
                  base64: `data:image/png;base64,${Buffer.from(assetDataBuf).toString("base64")}`,
                });
              })(),
            );
          } else if (p1 === "icon") {
            assetPromises.push(
              (async () => {
                const assetDataBuf = await host.readImage(
                  currentChar.image ?? "",
                );
                multimodal.push({
                  type: "image",
                  base64: `data:image/png;base64,${Buffer.from(assetDataBuf).toString("base64")}`,
                });
              })(),
            );
          }
          return "";
        },
      );
      await Promise.all(assetPromises);
      const chat: OpenAIChat = {
        role: role,
        content: formatedChat,
        memo: msg.chatId,
        attr: attr,
        multimodals: multimodal,
        thoughts: thoughts,
      };
      if (chat.multimodals.length === 0) {
        delete chat.multimodals;
      }
      chats.push(chat);
      currentTokens += await tokenizer.tokenizeChat(chat);
      index++;
    }
    console.log(JSON.stringify(chats, null, 2));
    const depthPrompts = lorepmt.actives.filter((v) => {
      return (v.pos === "depth" && v.depth > 0) || v.pos === "reverse_depth";
    });
    for (const depthPrompt of depthPrompts) {
      const chat: OpenAIChat = {
        role: depthPrompt.role,
        content: host.risuChatParser(resolvePosition(depthPrompt.prompt), {
          chara: currentChar,
        }),
      };
      currentTokens += await tokenizer.tokenizeChat(chat);
    }
    if (
      nowChatroom.supaMemory &&
      (host.DBState.db.supaModelType !== "none" ||
        host.DBState.db.hanuraiEnable ||
        host.DBState.db.hypav2 ||
        host.DBState.db.hypaV3)
    ) {
      stageTimings.stage1Duration = Date.now() - stageTimings.stage1Start;
      host.chatProcessStage.set(2);
      stageTimings.stage2Start = Date.now();
      if (host.DBState.db.hanuraiEnable) {
        const hn = await host.hanuraiMemory(chats, {
          currentTokens,
          maxContextTokens,
          tokenizer,
        });
        if (hn === false) {
          return false;
        }
        chats = hn.chats;
        currentTokens = hn.tokens;
      } else if (host.DBState.db.hypav2) {
        console.log("Current chat's hypaV2 Data: ", currentChat.hypaV2Data);
        const sp = await host.hypaMemoryV2(
          chats,
          currentTokens,
          maxContextTokens,
          currentChat,
          nowChatroom,
          tokenizer,
        );
        if (sp.error) {
          console.log(sp);
          throwError(sp.error);
          return false;
        }
        chats = sp.chats;
        currentTokens = sp.currentTokens;
        currentChat.hypaV2Data = sp.memory ?? currentChat.hypaV2Data;
        host.DBState.db.characters[selectedChar].chats[
          selectedChat
        ].hypaV2Data = currentChat.hypaV2Data;
        currentChat =
          host.DBState.db.characters[selectedChar].chats[selectedChat];
        console.log(
          "[Expected to be updated] chat's HypaV2Data: ",
          currentChat.hypaV2Data,
        );
      } else if (host.DBState.db.hypaV3) {
        console.log("Current chat's hypaV3 Data: ", currentChat.hypaV3Data);
        const sp = await host.hypaMemoryV3(
          chats,
          currentTokens,
          maxContextTokens,
          currentChat,
          nowChatroom,
          tokenizer,
        );
        if (sp.error) {
          // Save new summary
          if (sp.memory) {
            currentChat.hypaV3Data = sp.memory;
            host.DBState.db.characters[selectedChar].chats[
              selectedChat
            ].hypaV3Data = currentChat.hypaV3Data;
          }
          console.log(sp);
          throwError(sp.error);
          return false;
        }
        chats = sp.chats;
        currentTokens = sp.currentTokens;
        currentChat.hypaV3Data = sp.memory ?? currentChat.hypaV3Data;
        host.DBState.db.characters[selectedChar].chats[
          selectedChat
        ].hypaV3Data = currentChat.hypaV3Data;
        currentChat =
          host.DBState.db.characters[selectedChar].chats[selectedChat];
        console.log(
          "[Expected to be updated] chat's HypaV3Data: ",
          currentChat.hypaV3Data,
        );
      } else {
        const sp = await host.supaMemory(
          chats,
          currentTokens,
          maxContextTokens,
          currentChat,
          nowChatroom,
          tokenizer,
          {
            asHyper: host.DBState.db.hypaMemory,
          },
        );
        if (sp.error) {
          throwError(sp.error);
          return false;
        }
        chats = sp.chats;
        currentTokens = sp.currentTokens;
        currentChat.supaMemoryData = sp.memory ?? currentChat.supaMemoryData;
        host.DBState.db.characters[selectedChar].chats[
          selectedChat
        ].supaMemoryData = currentChat.supaMemoryData;
        console.log(currentChat.supaMemoryData);
        currentChat.lastMemory = sp.lastId ?? currentChat.lastMemory;
      }
      stageTimings.stage2Duration = Date.now() - stageTimings.stage2Start;
      host.chatProcessStage.set(1);
    } else {
      stageTimings.stage1Duration = Date.now() - stageTimings.stage1Start;
      while (currentTokens > maxContextTokens) {
        if (chats.length <= 1) {
          throwError(
            host.language.errors.toomuchtoken +
              "\n\nRequired Tokens: " +
              currentTokens,
          );
          return false;
        }
        currentTokens -= await tokenizer.tokenizeChat(chats[0]);
        chats.splice(0, 1);
      }
      currentChat.lastMemory = chats[0].memo;
    }
    let biases: [string, number][] = host.DBState.db.bias
      .concat(currentChar.bias)
      .map((v) => {
        return [
          host.risuChatParser(
            v[0]
              .replaceAll("\\n", "\n")
              .replaceAll("\\r", "\r")
              .replaceAll("\\\\", "\\"),
            { chara: currentChar },
          ),
          v[1],
        ];
      });
    let memories: OpenAIChat[] = [];
    if (!promptTemplate) {
      unformated.lastChat.push(chats[chats.length - 1]);
      chats.splice(chats.length - 1, 1);
    }
    unformated.chats = chats
      .map((v) => {
        if (v.memo !== "supaMemory" && v.memo !== "hypaMemory") {
          v.removable = true;
        } else if (supaMemoryCardUsed) {
          memories.push(v);
          return {
            role: "system",
            content: "",
          } as OpenAIChat;
        } else {
          v.content = `<Previous Conversation>${v.content}</Previous Conversation>`;
        }
        return v;
      })
      .filter((v) => {
        return (
          v.content.trim() !== "" || (v.multimodals && v.multimodals.length > 0)
        );
      });
    for (const depthPrompt of depthPrompts) {
      const chat: OpenAIChat = {
        role: depthPrompt.role,
        content: host.risuChatParser(resolvePosition(depthPrompt.prompt), {
          chara: currentChar,
        }),
      };
      const depth =
        depthPrompt.pos === "depth"
          ? depthPrompt.depth
          : unformated.chats.length - depthPrompt.depth;
      unformated.chats.splice(depth, 0, chat);
    }
    if (triggerResult) {
      if (triggerResult.additonalSysPrompt.promptend) {
        unformated.postEverything.push({
          role: "system",
          content: triggerResult.additonalSysPrompt.promptend,
        });
      }
      if (triggerResult.additonalSysPrompt.historyend) {
        unformated.lastChat.push({
          role: "system",
          content: triggerResult.additonalSysPrompt.historyend,
        });
      }
      if (triggerResult.additonalSysPrompt.start) {
        unformated.lastChat.unshift({
          role: "system",
          content: triggerResult.additonalSysPrompt.start,
        });
      }
    }
    //make into one
    let formated: OpenAIChat[] = [];
    const formatOrder = host.safeStructuredClone(
      host.DBState.db.formatingOrder,
    );
    if (formatOrder) {
      formatOrder.push("postEverything");
    }
    //continue chat model
    if (
      arg.continue &&
      (host.DBState.db.aiModel.startsWith("claude") ||
        host.DBState.db.aiModel.startsWith("gpt") ||
        host.DBState.db.aiModel.startsWith("openrouter") ||
        host.DBState.db.aiModel.startsWith("reverse_proxy"))
    ) {
      unformated.postEverything.push({
        role: "system",
        content: "[Continue the last response]",
      });
    }
    function pushPrompts(cha: OpenAIChat[]) {
      for (const chat of cha) {
        if (
          !chat.content.trim() &&
          !(chat.multimodals && chat.multimodals.length > 0)
        ) {
          continue;
        }
        if (
          !(
            host.DBState.db.aiModel.startsWith("gpt") ||
            host.DBState.db.aiModel.startsWith("claude") ||
            host.DBState.db.aiModel === "openrouter" ||
            host.DBState.db.aiModel === "reverse_proxy"
          )
        ) {
          formated.push(chat);
          continue;
        }
        if (chat.role === "system") {
          const endf = formated.at(-1);
          if (
            endf &&
            endf.role === "system" &&
            endf.memo === chat.memo &&
            endf.name === chat.name
          ) {
            formated[formated.length - 1].content += "\n\n" + chat.content;
          } else {
            formated.push(chat);
          }
          formated.at(-1).content += "";
        } else {
          formated.push(chat);
        }
      }
    }
    let promptBodyformatedForChatStore: OpenAIChat[] = [];
    function pushPromptInfoBody(
      role: "function" | "system" | "user" | "assistant",
      fmt: string,
      promptBody: OpenAIChat[],
    ) {
      if (!fmt.trim()) {
        return;
      }
      promptBody.push({
        role: role,
        content: host.risuChatParser(fmt),
      });
    }
    if (promptTemplate) {
      const template = promptTemplate;
      for (const card of template) {
        switch (card.type) {
          case "persona": {
            let pmt = host.safeStructuredClone(unformated.personaPrompt);
            applyPromptBlockRole(pmt, card.role2);
            if (card.innerFormat && pmt.length > 0) {
              for (let i = 0; i < pmt.length; i++) {
                pmt[i].content = host
                  .risuChatParser(positionParser(card.innerFormat, card.type), {
                    chara: currentChar,
                  })
                  .replace("{{slot}}", pmt[i].content);
                if (
                  host.DBState.db.promptInfoInsideChat &&
                  host.DBState.db.promptTextInfoInsideChat
                ) {
                  pushPromptInfoBody(
                    pmt[i].role,
                    card.innerFormat,
                    promptBodyformatedForChatStore,
                  );
                }
              }
            }
            pushPrompts(pmt);
            break;
          }
          case "description": {
            let pmt = getDescriptionPrompts(card.role2);
            if (card.innerFormat && pmt.length > 0) {
              for (let i = 0; i < pmt.length; i++) {
                pmt[i].content = host
                  .risuChatParser(positionParser(card.innerFormat, card.type), {
                    chara: currentChar,
                  })
                  .replace("{{slot}}", pmt[i].content);
                if (
                  host.DBState.db.promptInfoInsideChat &&
                  host.DBState.db.promptTextInfoInsideChat
                ) {
                  pushPromptInfoBody(
                    pmt[i].role,
                    card.innerFormat,
                    promptBodyformatedForChatStore,
                  );
                }
              }
            }
            pushPrompts(pmt);
            break;
          }
          case "authornote": {
            let pmt = host.safeStructuredClone(unformated.authorNote);
            applyPromptBlockRole(pmt, card.role2);
            if (card.innerFormat && pmt.length > 0) {
              for (let i = 0; i < pmt.length; i++) {
                pmt[i].content = host
                  .risuChatParser(positionParser(card.innerFormat, card.type), {
                    chara: currentChar,
                  })
                  .replace(
                    "{{slot}}",
                    pmt[i].content || card.defaultText || "",
                  );
                if (
                  host.DBState.db.promptInfoInsideChat &&
                  host.DBState.db.promptTextInfoInsideChat
                ) {
                  pushPromptInfoBody(
                    pmt[i].role,
                    card.innerFormat,
                    promptBodyformatedForChatStore,
                  );
                }
              }
            }
            pushPrompts(pmt);
            break;
          }
          case "lorebook": {
            pushPrompts(unformated.lorebook);
            break;
          }
          case "postEverything": {
            pushPrompts(unformated.postEverything);
            if (
              usingPromptTemplate &&
              host.DBState.db.promptSettings.postEndInnerFormat
            ) {
              pushPrompts([
                {
                  role: "system",
                  content: host.DBState.db.promptSettings.postEndInnerFormat,
                },
              ]);
            }
            break;
          }
          case "plain":
          case "jailbreak":
          case "cot": {
            if (!host.DBState.db.jailbreakToggle && card.type === "jailbreak") {
              continue;
            }
            if (!host.DBState.db.chainOfThought && card.type === "cot") {
              continue;
            }
            const posType = card.type === "plain" ? card.type2 : card.type;
            let content = positionParser(card.text, posType);
            if (card.type2 === "globalNote") {
              if (currentChar.replaceGlobalNote) {
                content = positionParser(
                  currentChar.replaceGlobalNote,
                  posType,
                ).replaceAll("{{original}}", content);
              }
              if (
                currentChar.prebuiltAssetCommand &&
                !card.text.includes("{{//@customimageinstruction}}")
              ) {
                content += host.prebuiltAssetCommand;
              }
              content = host.risuChatParser(content, {
                chara: currentChar,
                role: card.role,
              });
            } else if (card.type2 === "main") {
              content = host.risuChatParser(content, {
                chara: currentChar,
                role: card.role,
              });
            } else {
              content = host.risuChatParser(content, {
                chara: currentChar,
                role: card.role,
              });
            }
            const prompt: OpenAIChat = {
              role: convertPromptRole[card.role],
              content: content,
            };
            if (
              host.DBState.db.promptInfoInsideChat &&
              host.DBState.db.promptTextInfoInsideChat &&
              card.type2 !== "globalNote"
            ) {
              pushPromptInfoBody(
                prompt.role,
                prompt.content,
                promptBodyformatedForChatStore,
              );
            }
            pushPrompts([prompt]);
            break;
          }
          case "chatML": {
            let prompts = host.parseChatML(card.text);
            pushPrompts(prompts);
            break;
          }
          case "chat": {
            let start = card.rangeStart;
            let end =
              card.rangeEnd === "end" ? unformated.chats.length : card.rangeEnd;
            if (start === -1000) {
              start = 0;
              end = unformated.chats.length;
            }
            if (start < 0) {
              start = unformated.chats.length + start;
              if (start < 0) {
                start = 0;
              }
            }
            if (end < 0) {
              end = unformated.chats.length + end;
              if (end < 0) {
                end = 0;
              }
            }
            if (start >= end) {
              break;
            }
            let chats = unformated.chats.slice(start, end);
            if (
              usingPromptTemplate &&
              host.DBState.db.promptSettings.sendChatAsSystem &&
              !card.chatAsOriginalOnSystem
            ) {
              chats = systemizeChat(chats);
            }
            pushPrompts(chats);
            if (host.DBState.db.automaticCachePoint && !hasCachePoint) {
              let pointer = formated.length - 1;
              let depthRemaining = 3;
              while (pointer >= 0) {
                if (depthRemaining === 0) {
                  break;
                }
                if (formated[pointer].role === "user") {
                  formated[pointer].cachePoint = true;
                  depthRemaining--;
                }
                pointer--;
              }
            }
            break;
          }
          case "memory": {
            let pmt = host.safeStructuredClone(memories);
            applyPromptBlockRole(pmt, card.role2);
            if (card.innerFormat && pmt.length > 0) {
              for (let i = 0; i < pmt.length; i++) {
                pmt[i].content = host
                  .risuChatParser(card.innerFormat, { chara: currentChar })
                  .replace("{{slot}}", pmt[i].content);
                if (
                  host.DBState.db.promptInfoInsideChat &&
                  host.DBState.db.promptTextInfoInsideChat
                ) {
                  pushPromptInfoBody(
                    pmt[i].role,
                    card.innerFormat,
                    promptBodyformatedForChatStore,
                  );
                }
              }
            }
            pushPrompts(pmt);
            break;
          }
          case "cache": {
            let pointer = formated.length - 1;
            let depthRemaining = card.depth;
            while (pointer >= 0) {
              if (depthRemaining === 0) {
                break;
              }
              if (formated[pointer].role === card.role || card.role === "all") {
                formated[pointer].cachePoint = true;
                depthRemaining--;
              }
              pointer--;
            }
            break;
          }
        }
      }
    } else {
      for (let i = 0; i < formatOrder.length; i++) {
        const cha = unformated[formatOrder[i]];
        pushPrompts(cha);
      }
    }
    formated = formated.map((v) => {
      v.content = v.content.trim();
      return v;
    });
    if (
      host.DBState.db.promptInfoInsideChat &&
      host.DBState.db.promptTextInfoInsideChat
    ) {
      promptBodyformatedForChatStore = promptBodyformatedForChatStore.map(
        (v) => {
          v.content = v.content.trim();
          return v;
        },
      );
    }
    if (
      currentChar.depth_prompt &&
      currentChar.depth_prompt.prompt &&
      currentChar.depth_prompt.prompt.length > 0
    ) {
      //depth_prompt
      const depthPrompt = currentChar.depth_prompt;
      formated.splice(formated.length - depthPrompt.depth, 0, {
        role: "system",
        content: host.risuChatParser(depthPrompt.prompt, {
          chara: currentChar,
        }),
      });
    }
    formated = await host.runLuaEditTrigger(
      currentChar,
      "editRequest",
      formated,
    );
    if (
      host.DBState.db.promptInfoInsideChat &&
      host.DBState.db.promptTextInfoInsideChat
    ) {
      promptBodyformatedForChatStore = await host.runLuaEditTrigger(
        currentChar,
        "editRequest",
        promptBodyformatedForChatStore,
      );
      promptInfo.promptText = promptBodyformatedForChatStore;
    }
    //token rechecking
    let inputTokens = 0;
    for (const chat of formated) {
      inputTokens += await tokenizer.tokenizeChat(chat);
    }
    if (inputTokens > maxContextTokens) {
      let pointer = 0;
      while (inputTokens > maxContextTokens) {
        if (pointer >= formated.length) {
          throwError(
            host.language.errors.toomuchtoken +
              "\n\nAt token rechecking. Required Tokens: " +
              inputTokens,
          );
          return false;
        }
        if (formated[pointer].removable) {
          inputTokens -= await tokenizer.tokenizeChat(formated[pointer]);
          formated[pointer].content = "";
        }
        pointer++;
      }
      formated = formated.filter((v) => {
        return v.content !== "" || (v.multimodals && v.multimodals.length > 0);
      });
    }
    //estimate tokens
    let outputTokens = host.DBState.db.maxResponse;
    if (inputTokens + outputTokens > maxContextTokens) {
      outputTokens = maxContextTokens - inputTokens;
    }
    const generationId = host.v4();
    const generationModel = host.getGenerationModelString();
    generationInfo = {
      model: generationModel,
      generationId: generationId,
      inputTokens: inputTokens,
      outputTokens: outputTokens,
      maxContext: maxContextTokens,
      stageTiming: {
        stage1: stageTimings.stage1Duration,
        stage2: stageTimings.stage2Duration,
        stage3: 0,
        stage4: 0,
      },
    };
    host.chatProcessStage.set(3);
    stageTimings.stage3Start = Date.now();
    if (arg.preview) {
      host.previewFormated = formated;
      return true;
    }
    const req = await host.requestChatData(
      {
        formated: formated,
        biasString: biases,
        currentChar: currentChar,
        useStreaming: true,
        isGroupChat: nowChatroom.type === "group",
        bias: {},
        continue: arg.continue,
        chatId: generationId,
        imageResponse: host.DBState.db.outputImageModal,
        previewBody: arg.previewPrompt,
        escape: nowChatroom.type === "character" && nowChatroom.escapeOutput,
        rememberToolUsage: host.DBState.db.rememberToolUsage,
      },
      "model",
      abortSignal,
    );
    console.log(req);
    if (req.model) {
      generationInfo.model = host.getGenerationModelString(req.model);
      console.log(generationInfo.model, req.model);
    }
    if (arg.previewPrompt && req.type === "success") {
      host.previewBody = req.result;
      return true;
    }
    let result = "";
    let emoChanged = false;
    let resendChat = false;
    if (abortSignal.aborted === true) {
      return false;
    }
    if (req.type === "fail") {
      throwError(req.result);
      return false;
    } else if (req.type === "streaming") {
      const reader = req.result.getReader();
      let msgIndex =
        host.DBState.db.characters[selectedChar].chats[selectedChat].message
          .length;
      let prefix = "";
      if (arg.continue) {
        msgIndex -= 1;
        const outputMessage =
          host.DBState.db.characters[selectedChar].chats[selectedChat].message[
            msgIndex
          ];
        prefix = outputMessage.data;
      } else {
        host.DBState.db.characters[selectedChar].chats[
          selectedChat
        ].message.push({
          role: "char",
          data: "",
          saying: currentChar.chaId,
          time: Date.now(),
          generationInfo,
          promptInfo,
          chatId: generationId,
        });
      }
      const outputMessageId =
        host.DBState.db.characters[selectedChar].chats[selectedChat].message[
          msgIndex
        ]?.chatId;
      const performanceMode: StreamingDisplayOptimizationMode =
        host.DBState.db.streamingDisplayOptimizationMode ?? "off";
      host.DBState.db.characters[selectedChar].chats[selectedChat].isStreaming =
        true;
      host.DBState.db.characters[selectedChar].chats[
        selectedChat
      ].activeStreamingDisplayOptimizationMode = performanceMode;
      host.DBState.db.characters[selectedChar].reloadKeys += 1;
      let lastResponseChunk: {
        [key: string]: string;
      } = {};
      let streamAborted: boolean = abortSignal.aborted;
      let receivedStreamingResult = false;
      const deferStreamingPostProcessing = performanceMode === "strong";
      const coalesceStreamingDisplay =
        performanceMode === "balanced" || performanceMode === "strong";
      const streamingDisplayFlushDelay = 125;
      let pendingStreamingResult: string | null = null;
      let streamingFlushTimer: ReturnType<typeof setTimeout> | null = null;
      let streamingFlushFrame: number | null = null;
      let streamingFlushPromise: Promise<void> | null = null;
      let streamingFlushQueued = false;
      let streamingFlushError: unknown = null;
      const clearStreamingFlushSchedule = () => {
        if (streamingFlushTimer !== null) {
          clearTimeout(streamingFlushTimer);
          streamingFlushTimer = null;
        }
        if (streamingFlushFrame !== null) {
          host.cancelAnimationFrame(streamingFlushFrame);
          streamingFlushFrame = null;
        }
      };
      const flushStreamingDisplay = async () => {
        clearStreamingFlushSchedule();
        if (streamingFlushPromise) {
          streamingFlushQueued = true;
          return streamingFlushPromise;
        }
        streamingFlushPromise = (async () => {
          do {
            streamingFlushQueued = false;
            const nextResult = pendingStreamingResult;
            pendingStreamingResult = null;
            if (nextResult === null) {
              continue;
            }
            if (deferStreamingPostProcessing) {
              host.DBState.db.characters[selectedChar].chats[
                selectedChat
              ].message[msgIndex].data = reformatContent(prefix + nextResult);
              host.DBState.db.characters[selectedChar].reloadKeys += 1;
              continue;
            }
            let result2 = await host.processScriptFull(
              nowChatroom,
              reformatContent(prefix + nextResult),
              "editoutput",
              msgIndex,
            );
            host.DBState.db.characters[selectedChar].chats[
              selectedChat
            ].message[msgIndex].data = result2.data;
            emoChanged = result2.emoChanged;
            host.DBState.db.characters[selectedChar].reloadKeys += 1;
          } while (streamingFlushQueued || pendingStreamingResult !== null);
        })().finally(() => {
          streamingFlushPromise = null;
        });
        return streamingFlushPromise;
      };
      const scheduleStreamingDisplayFlush = () => {
        if (streamingFlushTimer !== null || streamingFlushFrame !== null) {
          return;
        }
        streamingFlushTimer = setTimeout(() => {
          streamingFlushTimer = null;
          streamingFlushFrame = host.requestAnimationFrame(() => {
            streamingFlushFrame = null;
            void flushStreamingDisplay().catch((error) => {
              streamingFlushError ??= error;
              void reader.cancel().catch(() => {});
            });
          });
        }, streamingDisplayFlushDelay);
      };
      const abortReader = () => {
        streamAborted = true;
        void reader.cancel().catch(() => {});
      };
      abortSignal.addEventListener("abort", abortReader, { once: true });
      try {
        while (streamAborted === false) {
          let readed: ReadableStreamReadResult<{
            [key: string]: string;
          }>;
          try {
            readed = await reader.read();
          } catch (error) {
            if (abortSignal.aborted || streamAborted) {
              streamAborted = true;
              break;
            }
            throw error;
          }
          if (readed.value) {
            receivedStreamingResult = true;
            lastResponseChunk = readed.value;
            const firstChunkKey = Object.keys(lastResponseChunk)[0];
            result = lastResponseChunk[firstChunkKey];
            if (!result) {
              result = "";
            }
            if (host.DBState.db.removeIncompleteResponse) {
              result = host.trimUntilPunctuation(result);
            }
            if (coalesceStreamingDisplay) {
              pendingStreamingResult = result;
              scheduleStreamingDisplayFlush();
            } else {
              let result2 = await host.processScriptFull(
                nowChatroom,
                reformatContent(prefix + result),
                "editoutput",
                msgIndex,
              );
              host.DBState.db.characters[selectedChar].chats[
                selectedChat
              ].message[msgIndex].data = result2.data;
              emoChanged = result2.emoChanged;
              host.DBState.db.characters[selectedChar].reloadKeys += 1;
            }
          }
          if (readed.done) {
            break;
          }
        }
      } finally {
        abortSignal.removeEventListener("abort", abortReader);
        try {
          if (coalesceStreamingDisplay) {
            try {
              await flushStreamingDisplay();
            } catch (error) {
              streamingFlushError ??= error;
            }
          }
          if (streamingFlushError !== null) {
            throw streamingFlushError;
          }
          if (deferStreamingPostProcessing && receivedStreamingResult) {
            let result2 = await host.processScriptFull(
              nowChatroom,
              reformatContent(prefix + result),
              "editoutput",
              msgIndex,
            );
            host.DBState.db.characters[selectedChar].chats[
              selectedChat
            ].message[msgIndex].data = result2.data;
            emoChanged = result2.emoChanged;
          }
        } finally {
          host.DBState.db.characters[selectedChar].chats[
            selectedChat
          ].isStreaming = false;
          host.DBState.db.characters[selectedChar].chats[
            selectedChat
          ].activeStreamingDisplayOptimizationMode = undefined;
          host.DBState.db.characters[selectedChar].reloadKeys += 1;
          void reader.cancel().catch(() => {});
        }
      }
      if (streamAborted || abortSignal.aborted) {
        return false;
      }
      host.addRerolls(generationId, Object.values(lastResponseChunk));
      host.DBState.db.characters[selectedChar].chats[selectedChat] =
        runCurrentChatFunction(
          host.DBState.db.characters[selectedChar].chats[selectedChat],
        );
      currentChat =
        host.DBState.db.characters[selectedChar].chats[selectedChat];
      const triggerResult = await host.runTrigger(currentChar, "output", {
        chat: currentChat,
      });
      if (triggerResult && triggerResult.chat) {
        currentChat = triggerResult.chat;
      }
      if (triggerResult && triggerResult.sendAIprompt) {
        resendChat = true;
      }
      host.DBState.db.characters[selectedChar].chats[selectedChat] =
        currentChat;
      currentChat =
        host.DBState.db.characters[selectedChar].chats[selectedChat];
      const inlayMessageIndex = findMessageIndexByChatId(
        currentChat,
        outputMessageId,
      );
      const outputMessage = currentChat.message[inlayMessageIndex];
      if (outputMessage) {
        const inlayr = host.runInlayScreen(currentChar, outputMessage.data);
        outputMessage.data = inlayr.text;
        host.DBState.db.characters[selectedChar].chats[selectedChat] =
          currentChat;
        if (inlayr.promise) {
          const t = await inlayr.promise;
          currentChat =
            host.DBState.db.characters[selectedChar].chats[selectedChat];
          const asyncInlayMessageIndex = findMessageIndexByChatId(
            currentChat,
            outputMessageId,
          );
          if (asyncInlayMessageIndex !== -1) {
            currentChat.message[asyncInlayMessageIndex].data = t;
            host.DBState.db.characters[selectedChar].chats[selectedChat] =
              currentChat;
          }
        }
      }
      currentChat =
        host.DBState.db.characters[selectedChar].chats[selectedChat];
      const listenerMessageIndex = findMessageIndexByChatId(
        currentChat,
        outputMessageId,
      );
      await runChatOutputListeners(
        currentChar,
        currentChat,
        selectedChar,
        selectedChat,
        listenerMessageIndex,
      );
      if (host.DBState.db.ttsAutoSpeech) {
        await host.sayTTS(currentChar, result);
      }
    } else {
      const msgs =
        req.type === "success"
          ? ([["char", req.result]] as const)
          : req.type === "multiline"
            ? req.result
            : [];
      let mrerolls: string[] = [];
      let outputMessageIndex = -1;
      let outputMessageId: string | undefined;
      for (let i = 0; i < msgs.length; i++) {
        let msg = msgs[i];
        let mess = msg[1];
        let msgIndex =
          host.DBState.db.characters[selectedChar].chats[selectedChat].message
            .length;
        let result2 = await host.processScriptFull(
          nowChatroom,
          reformatContent(mess),
          "editoutput",
          msgIndex,
        );
        if (i === 0 && arg.continue) {
          msgIndex -= 1;
          let beforeChat =
            host.DBState.db.characters[selectedChar].chats[selectedChat]
              .message[msgIndex];
          result2 = await host.processScriptFull(
            nowChatroom,
            reformatContent(beforeChat.data + mess),
            "editoutput",
            msgIndex,
          );
        }
        if (host.DBState.db.removeIncompleteResponse) {
          result2.data = host.trimUntilPunctuation(result2.data);
        }
        result = result2.data;
        const inlayResult = host.runInlayScreen(currentChar, result);
        result = inlayResult.text;
        emoChanged = result2.emoChanged;
        if (i === 0 && arg.continue) {
          host.DBState.db.characters[selectedChar].chats[selectedChat].message[
            msgIndex
          ] = {
            role: "char",
            data: result,
            saying: currentChar.chaId,
            time: Date.now(),
            generationInfo,
            promptInfo,
            chatId: generationId,
          };
          if (inlayResult.promise) {
            const p = await inlayResult.promise;
            host.DBState.db.characters[selectedChar].chats[
              selectedChat
            ].message[msgIndex].data = p;
          }
          outputMessageIndex = msgIndex;
          outputMessageId =
            host.DBState.db.characters[selectedChar].chats[selectedChat]
              .message[msgIndex]?.chatId;
        } else if (i === 0) {
          host.DBState.db.characters[selectedChar].chats[
            selectedChat
          ].message.push({
            role: msg[0],
            data: result,
            saying: currentChar.chaId,
            time: Date.now(),
            generationInfo,
            promptInfo,
            chatId: generationId,
          });
          const ind =
            host.DBState.db.characters[selectedChar].chats[selectedChat].message
              .length - 1;
          if (inlayResult.promise) {
            const p = await inlayResult.promise;
            host.DBState.db.characters[selectedChar].chats[
              selectedChat
            ].message[ind].data = p;
          }
          mrerolls.push(result);
          outputMessageIndex = ind;
          outputMessageId =
            host.DBState.db.characters[selectedChar].chats[selectedChat]
              .message[ind]?.chatId;
        } else {
          mrerolls.push(result);
        }
        host.DBState.db.characters[selectedChar].reloadKeys += 1;
        if (host.DBState.db.ttsAutoSpeech) {
          await host.sayTTS(currentChar, result);
        }
      }
      if (mrerolls.length > 1) {
        host.addRerolls(generationId, mrerolls);
      }
      host.DBState.db.characters[selectedChar].chats[selectedChat] =
        runCurrentChatFunction(
          host.DBState.db.characters[selectedChar].chats[selectedChat],
        );
      currentChat =
        host.DBState.db.characters[selectedChar].chats[selectedChat];
      const triggerResult = await host.runTrigger(currentChar, "output", {
        chat: currentChat,
      });
      if (triggerResult && triggerResult.chat) {
        host.DBState.db.characters[selectedChar].chats[selectedChat] =
          triggerResult.chat;
      }
      if (triggerResult && triggerResult.sendAIprompt) {
        resendChat = true;
      }
      currentChat =
        host.DBState.db.characters[selectedChar].chats[selectedChat];
      if (outputMessageId) {
        outputMessageIndex = findMessageIndexByChatId(
          currentChat,
          outputMessageId,
        );
        await runChatOutputListeners(
          currentChar,
          currentChat,
          selectedChar,
          selectedChat,
          outputMessageIndex,
        );
      }
    }
    let needsAutoContinue = false;
    const resultTokens =
      (await host.tokenize(result)) + (arg.usedContinueTokens || 0);
    if (
      host.DBState.db.autoContinueMinTokens > 0 &&
      resultTokens < host.DBState.db.autoContinueMinTokens
    ) {
      needsAutoContinue = true;
    }
    if (
      host.DBState.db.autoContinueChat &&
      !host.isLastCharPunctuation(result)
    ) {
      //if result doesn't end with punctuation or special characters, auto continue
      needsAutoContinue = true;
    }
    if (needsAutoContinue) {
      host.doingChat.set(false);
      return await sendChat(chatProcessIndex, {
        chatAdditonalTokens: arg.chatAdditonalTokens,
        continue: true,
        signal: abortSignal,
        usedContinueTokens: resultTokens,
      });
    }
    const igp = host.risuChatParser(host.DBState.db.igpPrompt ?? "");
    if (igp) {
      const igpFormated = host.parseChatML(igp);
      const rq = await host.requestChatData(
        {
          formated: igpFormated,
          bias: {},
        },
        "emotion",
        abortSignal,
      );
      host.DBState.db.characters[selectedChar].chats[selectedChat].message[
        host.DBState.db.characters[selectedChar].chats[selectedChat].message
          .length - 1
      ].data += rq;
    }
    stageTimings.stage3Duration = Date.now() - stageTimings.stage3Start;
    if (generationInfo.stageTiming) {
      generationInfo.stageTiming.stage3 = stageTimings.stage3Duration;
    }
    host.chatProcessStage.set(4);
    stageTimings.stage4Start = Date.now();
    if (resendChat) {
      stageTimings.stage4Duration = Date.now() - stageTimings.stage4Start;
      if (generationInfo.stageTiming) {
        generationInfo.stageTiming.stage1 = stageTimings.stage1Duration;
        generationInfo.stageTiming.stage2 = stageTimings.stage2Duration;
        generationInfo.stageTiming.stage3 = stageTimings.stage3Duration;
        generationInfo.stageTiming.stage4 = stageTimings.stage4Duration;
      }
      const lastMessageIndex =
        host.DBState.db.characters[selectedChar].chats[selectedChat].message
          .length - 1;
      if (
        lastMessageIndex >= 0 &&
        host.DBState.db.characters[selectedChar].chats[selectedChat].message[
          lastMessageIndex
        ].generationInfo
      ) {
        host.DBState.db.characters[selectedChar].chats[selectedChat].message[
          lastMessageIndex
        ].generationInfo = generationInfo;
      }
      host.doingChat.set(false);
      return await sendChat(chatProcessIndex, {
        signal: abortSignal,
      });
    }
    if (host.DBState.db.notification) {
      try {
        await host.notify(result);
      } catch {}
    }

    host.peerSync();
    if (req.special) {
      if (req.special.emotion) {
        let charemotions = get(host.CharEmotion);
        let currentEmotion = currentChar.emotionImages;
        let tempEmotion = charemotions[currentChar.chaId];
        if (!tempEmotion) {
          tempEmotion = [];
        }
        if (tempEmotion.length > 4) {
          tempEmotion.splice(0, 1);
        }
        for (const emo of currentEmotion) {
          if (emo[0] === req.special.emotion) {
            const emos: [string, string, number] = [emo[0], emo[1], Date.now()];
            tempEmotion.push(emos);
            charemotions[currentChar.chaId] = tempEmotion;
            host.CharEmotion.set(charemotions);
            emoChanged = true;
            break;
          }
        }
      }
    }
    if (!currentChar.inlayViewScreen) {
      if (
        currentChar.viewScreen === "emotion" &&
        !emoChanged &&
        abortSignal.aborted === false
      ) {
        let currentEmotion = currentChar.emotionImages;
        let emotionList = currentEmotion.map((a) => {
          return a[0];
        });
        let charemotions = get(host.CharEmotion);
        let tempEmotion = charemotions[currentChar.chaId];
        if (!tempEmotion) {
          tempEmotion = [];
        }
        if (tempEmotion.length > 4) {
          tempEmotion.splice(0, 1);
        }
        if (host.DBState.db.emotionProcesser === "embedding") {
          const hypaProcesser = new host.HypaProcesser();
          await hypaProcesser.addText(emotionList.map((v) => "emotion:" + v));
          let searched = (
            await hypaProcesser.similaritySearchScored(result)
          ).map((v) => {
            v[0] = v[0].replace("emotion:", "");
            return v;
          });
          //give panaltys
          for (let i = 0; i < tempEmotion.length; i++) {
            const emo = tempEmotion[i];
            //give panalty index
            const index = searched.findIndex((v) => {
              return v[0] === emo[0];
            });
            const modifier = (5 - (tempEmotion.length - (i + 1))) / 200;
            if (index !== -1) {
              searched[index][1] -= modifier;
            }
          }
          //make a sorted array by score
          const emoresult = searched
            .sort((a, b) => {
              return b[1] - a[1];
            })
            .map((v) => {
              return v[0];
            });
          for (const emo of currentEmotion) {
            if (emo[0] === emoresult[0]) {
              const emos: [string, string, number] = [
                emo[0],
                emo[1],
                Date.now(),
              ];
              tempEmotion.push(emos);
              charemotions[currentChar.chaId] = tempEmotion;
              host.CharEmotion.set(charemotions);
              break;
            }
          }
          return true;
        }
        function shuffleArray(array: string[]) {
          for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
          }
          return array;
        }
        let emobias: {
          [key: number]: number;
        } = {};
        for (const emo of emotionList) {
          const tokens = await host.tokenizeNum(emo);
          for (const token of tokens) {
            emobias[token] = 10;
          }
        }
        for (let i = 0; i < tempEmotion.length; i++) {
          const emo = tempEmotion[i];
          const tokens = await host.tokenizeNum(emo[0]);
          const modifier = 20 - (tempEmotion.length - (i + 1)) * (20 / 4);
          for (const token of tokens) {
            emobias[token] -= modifier;
            if (emobias[token] < -100) {
              emobias[token] = -100;
            }
          }
        }
        const promptbody: OpenAIChat[] = [
          {
            role: "system",
            content: `${host.DBState.db.emotionPrompt2 || "From the list below, choose a word that best represents a character's outfit description, action, or emotion in their dialogue. Prioritize selecting words related to outfit first, then action, and lastly emotion. Print out the chosen word."}\n\n list: ${shuffleArray(emotionList).join(", ")} \noutput only one word.`,
          },
          {
            role: "user",
            content: `"Good morning, Master! Is there anything I can do for you today?"`,
          },
          {
            role: "assistant",
            content: "happy",
          },
          {
            role: "user",
            content: result,
          },
        ];
        const rq = await host.requestChatData(
          {
            formated: promptbody,
            bias: emobias,
            currentChar: currentChar,
            maxTokens: 30,
          },
          "emotion",
          abortSignal,
        );
        if (rq.type === "fail") {
          if (abortSignal.aborted) {
            return true;
          }
          throwError(rq.result);
          return true;
        }
        if (rq.type === "streaming" || rq.type === "multiline") {
          if (abortSignal.aborted) {
            return true;
          }
          throwError("Unexpected response type");
          return true;
        } else {
          emotionList = currentEmotion.map((a) => {
            return a[0];
          });
          try {
            const emotion: string = rq.result
              .replace(/ |\n/g, "")
              .trim()
              .toLocaleLowerCase();
            let emotionSelected = false;
            for (const emo of currentEmotion) {
              if (emo[0] === emotion) {
                const emos: [string, string, number] = [
                  emo[0],
                  emo[1],
                  Date.now(),
                ];
                tempEmotion.push(emos);
                charemotions[currentChar.chaId] = tempEmotion;
                host.CharEmotion.set(charemotions);
                emotionSelected = true;
                break;
              }
            }
            if (!emotionSelected) {
              for (const emo of currentEmotion) {
                if (emotion.includes(emo[0])) {
                  const emos: [string, string, number] = [
                    emo[0],
                    emo[1],
                    Date.now(),
                  ];
                  tempEmotion.push(emos);
                  charemotions[currentChar.chaId] = tempEmotion;
                  host.CharEmotion.set(charemotions);
                  emotionSelected = true;
                  break;
                }
              }
            }
            if (!emotionSelected && emotionList.includes("neutral")) {
              const emo = currentEmotion[emotionList.indexOf("neutral")];
              const emos: [string, string, number] = [
                emo[0],
                emo[1],
                Date.now(),
              ];
              tempEmotion.push(emos);
              charemotions[currentChar.chaId] = tempEmotion;
              host.CharEmotion.set(charemotions);
              emotionSelected = true;
            }
          } catch (error) {
            throwError(host.language.errors.httpError + `${error}`);
            return true;
          }
        }
        return true;
      } else if (currentChar.viewScreen === "imggen") {
        if (chatProcessIndex !== -1) {
          throwError("Stable diffusion in group chat is not supported");
        }
        const msgs =
          host.DBState.db.characters[selectedChar].chats[selectedChat].message;
        let msgStr = "";
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === "char") {
            msgStr =
              `character: ${msgs[i].data.replace(/\n/g, " ")} \n` + msgStr;
          } else {
            msgStr = `user: ${msgs[i].data.replace(/\n/g, " ")} \n` + msgStr;
            break;
          }
        }
        await host.stableDiff(currentChar, msgStr);
      }
    }
    stageTimings.stage4Duration = Date.now() - stageTimings.stage4Start;
    if (generationInfo.stageTiming) {
      generationInfo.stageTiming.stage1 = stageTimings.stage1Duration;
      generationInfo.stageTiming.stage2 = stageTimings.stage2Duration;
      generationInfo.stageTiming.stage3 = stageTimings.stage3Duration;
      generationInfo.stageTiming.stage4 = stageTimings.stage4Duration;
    }
    const lastMessageIndex =
      host.DBState.db.characters[selectedChar].chats[selectedChat].message
        .length - 1;
    if (
      lastMessageIndex >= 0 &&
      host.DBState.db.characters[selectedChar].chats[selectedChat].message[
        lastMessageIndex
      ].generationInfo
    ) {
      host.DBState.db.characters[selectedChar].chats[selectedChat].message[
        lastMessageIndex
      ].generationInfo = generationInfo;
    }
    return true;
  }

  function systemizeChat(chat: OpenAIChat[]) {
    for (let i = 0; i < chat.length; i++) {
      if (chat[i].role === "user" || chat[i].role === "assistant") {
        const attr = chat[i].attr ?? [];
        if (chat[i].name?.startsWith("example_")) {
          chat[i].content = chat[i].name + ": " + chat[i].content;
        } else if (!attr.includes("nameAdded")) {
          chat[i].content = chat[i].role + ": " + chat[i].content;
        }
        chat[i].role = "system";
        delete chat[i].memo;
        delete chat[i].name;
      }
    }
    return chat;
  }
  return { sendChat };
}
