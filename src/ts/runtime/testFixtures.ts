import { createRequire } from "node:module";
const { EntityStore } = createRequire(import.meta.url)(
  "../../../server/entity/store.cjs",
);
export const buttonCode = `
local calls = 0
function onButtonClick(id, data)
    calls = calls + 1
    setChatVar(id, 'choice', getChatVar(id, 'name') .. ':' .. data .. ':' .. calls)
    setState(id, 'lastButton', { data = data, calls = calls })
    setChat(id, 0, data)
    insertChat(id, 0, 'user', 'inserted:' .. data)
    addChat(id, 'char', 'appended:' .. data)
    return getChatVar(id, 'choice')
end`;

export function seed(
  store: any,
  options: {
    character?: Record<string, unknown>;
    settings?: Record<string, unknown>;
  } = {},
) {
  store.applyCommand("other-character", {
    type: "create-character",
    characterId: "other",
    definition: {
      name: "Other",
      type: "character",
      unknownExtension: { retained: true },
    },
  });
  store.applyCommand("character", {
    type: "create-character",
    characterId: "c",
    definition: {
      name: "Synthetic",
      type: "character",
      defaultVariables: "fallback=character\nshared=character",
      unknownExtension: { retained: true },
      triggerscript: [{ effect: [{ type: "triggerlua", code: buttonCode }] }],
      ...options.character,
    },
  });
  for (const chatId of ["a", "b"]) {
    store.applyCommand(`chat-${chatId}`, {
      type: "create-chat",
      characterId: "c",
      chatId,
      metadata: {
        name: chatId,
        bindedPersona: "persona",
        localLore: [],
        extension: { preserved: true },
      },
    });
    store.applyCommand(`message-${chatId}`, {
      type: "append-message",
      chatId,
      messageId: `m-${chatId}`,
      message: { role: "char", data: "before", extension: { retained: true } },
    });
    store.applyCommand(`variable-${chatId}`, {
      type: "set-chat-variable",
      chatId,
      key: "$name",
      value: chatId === "a" ? "Alpha" : "Beta",
      expectedRevision: 0,
    });
  }
  for (const [kind, resourceId, payload] of [
    [
      "settings",
      "global",
      {
        username: "Default",
        templateDefaultVariables: "shared=template\ntemplate=template",
        enabledModules: ["module"],
        promptTemplate: [{ type: "authornote", defaultText: "synthetic note" }],
        ...options.settings,
      },
    ],
    [
      "persona",
      "persona",
      {
        id: "persona",
        name: "Bound",
        icon: "synthetic.png",
        personaPrompt: "synthetic persona",
        largePortrait: true,
      },
    ],
    [
      "module",
      "module",
      {
        id: "module",
        name: "Fixture module",
        description: "synthetic",
        unknownExtension: { retained: true },
      },
    ],
    ["global-variable", "shared", "server-global"],
  ] as const)
    store.applyCommand(`resource-${kind}`, {
      type: "put-resource",
      kind,
      resourceId,
      expectedRevision: 0,
      payload,
    });
}
export function fixture(options: Parameters<typeof seed>[1] = {}) {
  const store = new EntityStore(":memory:");
  seed(store, options);
  return store;
}
export function claim(store: any, id = "job-a", chatId = "a") {
  store.enqueueJob(id, { type: "button", chatId });
  return store.claimJob("worker");
}
