<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import {
    entityRuntimeEnabled,
    browserRuntime,
    reportRuntimeError,
  } from "src/ts/runtime/browserRuntimeState.svelte";
  import { getFieldValue, setFieldValue } from "src/ts/runtime/fieldControls";
  import { commandJson } from "src/ts/runtime/clientProtocol";
  import type {
    ChatFolderTarget,
    ChatNavigationTarget,
  } from "src/ts/runtime/chatNavigation";
  import { v4 } from "uuid";
  import Sortable from "sortablejs/modular/sortable.core.esm.js";
  import {
    DownloadIcon,
    PencilIcon,
    HardDriveUploadIcon,
    MenuIcon,
    TrashIcon,
    SplitIcon,
    FolderPlusIcon,
    BookmarkCheckIcon,
  } from "@lucide/svelte";

  import type {
    Chat,
    ChatFolder,
    character,
    groupChat,
  } from "src/ts/storage/database.svelte";
  import { DBState, ReloadGUIPointer } from "src/ts/stores.svelte";
  import { selectedCharID } from "src/ts/stores.svelte";

  import CheckInput from "../UI/GUI/CheckInput.svelte";
  import Button from "../UI/GUI/Button.svelte";
  import TextInput from "../UI/GUI/TextInput.svelte";

  import { exportChat, importChat, exportAllChats } from "src/ts/characters";
  import {
    alertChatOptions,
    alertConfirm,
    alertError,
    alertNormal,
    alertSelect,
    alertStore,
  } from "src/ts/alert";
  import { findCharacterbyId, sleep, sortableOptions } from "src/ts/util";
  import { createMultiuserRoom } from "src/ts/sync/multiuser";
  import { bookmarkListOpen } from "src/ts/stores.svelte";
  import { language } from "src/lang";
  import Toggles from "./Toggles.svelte";
  import { changeChatTo, createChatCopyName } from "src/ts/globalApi.svelte";

  interface Props {
    chara: character | groupChat;
  }

  let { chara = $bindable() }: Props = $props();
  const foldersTarget = (owner: character | groupChat) => ({
    scope: "character" as const,
    entityId: owner.chaId,
    key: "chatFolders",
  });
  const folderValues = (owner: character | groupChat) =>
    getFieldValue(foldersTarget(owner), owner.chatFolders ?? []);
  let navigation = $derived(
    entityRuntimeEnabled
      ? browserRuntime().chatNavigationOverlay(chara.chaId)
      : undefined,
  );
  let displayFolders = $derived.by(() => {
    const folders = folderValues(chara);
    if (navigation?.type === "remove-chat-folder")
      return folders.filter((folder) => folder.id !== navigation.folderId);
    if (navigation?.type === "reorder-chat-navigation") {
      const ids = navigation.folderIds as string[],
        byId = new Map(folders.map((folder) => [folder.id, folder]));
      return [
        ...ids.map((id) => byId.get(id)).filter(Boolean),
        ...folders.filter((folder) => !ids.includes(folder.id)),
      ];
    }
    return folders;
  });
  let displayChats = $derived.by(() => {
    if (navigation?.type !== "reorder-chat-navigation") return chara.chats;
    const ids = navigation.chatIds as string[],
      byId = new Map(chara.chats.map((chat) => [chat.id, chat]));
    return [
      ...ids.map((id) => byId.get(id)).filter(Boolean),
      ...chara.chats.filter((chat) => !ids.includes(chat.id)),
    ];
  });
  function displayFolderId(chat: Chat) {
    const confirmed = getFieldValue(
      chatTarget(chat, "folderId"),
      chat.folderId,
    );
    if (
      navigation?.type === "remove-chat-folder" &&
      confirmed === navigation.folderId
    )
      return null;
    if (navigation?.type === "reorder-chat-navigation") {
      const move = (
        navigation.memberships as { chatId: string; folderId: string | null }[]
      ).find((item) => item.chatId === chat.id);
      if (move) return move.folderId;
    }
    return confirmed;
  }
  function captureFolderTarget(owner: character | groupChat, id: string) {
    try {
      return browserRuntime().captureChatFolder(owner.chaId, id);
    } catch (error) {
      reportRuntimeError(error);
      return undefined;
    }
  }
  function changeFolder(
    owner: character | groupChat,
    folder: ChatFolder,
    key: "name" | "folded" | "color",
    value: string | boolean,
    captured?: ChatFolderTarget,
  ) {
    if (!entityRuntimeEnabled) {
      (folder as any)[key] = value;
      return;
    }
    try {
      const current = folderValues(owner),
        live = current.find((item) => item.id === folder.id);
      if (!live || live[key] === value) return;
      const target =
        captured ?? browserRuntime().captureChatFolder(owner.chaId, folder.id);
      browserRuntime().setChatFolders(
        target,
        JSON.parse(
          commandJson(
            current.map((item) =>
              item.id === folder.id ? { ...item, [key]: value } : item,
            ),
          ),
        ),
      );
    } catch (error) {
      reportRuntimeError(error);
    }
  }
  const chatTarget = (chat: Chat, key: string) => ({
    scope: "chat" as const,
    entityId: chat.id,
    key,
  });
  async function cloneServerChat(chat: Chat) {
    try {
      await browserRuntime().cloneChat(
        chat.id,
        createChatCopyName(chat.name, "Copy"),
      );
    } catch (error) {
      reportRuntimeError(error);
    }
  }
  async function removeServerChat(chat: Chat) {
    try {
      await browserRuntime().deleteChat(chat.id);
    } catch (error) {
      reportRuntimeError(error);
    }
  }
  let editMode = $state(false);

  let chatsStb: Sortable[] = [];
  let folderStb: Sortable = null;

  let folderEles: HTMLDivElement = $state();
  let listEle: HTMLDivElement = $state();
  let sorted = $state(0);
  let opened = 0;
  let mounted = false;
  let rebuild = 0;
  let capturedNavigation: ChatNavigationTarget | undefined;

  function destroySortables() {
    folderStb?.destroy();
    folderStb = null;
    chatsStb.forEach((sortable) => sortable.destroy());
    chatsStb = [];
  }
  function captureNavigation() {
    if (!entityRuntimeEnabled) return;
    try {
      capturedNavigation = browserRuntime().captureChatNavigation(chara.chaId);
    } catch (error) {
      capturedNavigation = undefined;
      reportRuntimeError(error);
    }
  }
  async function commitServerSort(
    event: Sortable.SortableEvent,
    folderOrder = false,
  ) {
    const target = capturedNavigation;
    capturedNavigation = undefined;
    const folderIds = Array.from(folderEles.children)
      .map((child) => (child as HTMLElement).dataset.chatFolderId)
      .filter(Boolean);
    const chatIds = Array.from(
      listEle.querySelectorAll<HTMLElement>(
        "[data-chat-id][data-risu-chat-idx]",
      ),
    ).map((child) => child.dataset.chatId);
    const moved =
      !folderOrder && event.from !== event.to
        ? {
            chatId: event.item.dataset.chatId,
            folderId:
              event.item.closest<HTMLElement>("[data-chat-folder-id]")?.dataset
                .chatFolderId ?? null,
          }
        : undefined;
    // Return Sortable's external DOM edit to Svelte before private projection.
    const originalSiblings = Array.from(event.from.children).filter(
      (child) => child !== event.item,
    );
    event.from.insertBefore(
      event.item,
      originalSiblings[event.oldIndex] ?? null,
    );
    try {
      if (!target || target.characterId !== chara.chaId)
        throw new Error("The dragged character changed before admission");
      await browserRuntime().reorderChatNavigation(
        target,
        folderIds,
        chatIds,
        moved,
      );
    } catch (error) {
      reportRuntimeError(error);
    } finally {
      await tick();
      if (mounted) createStb();
    }
  }

  const createStb = () => {
    destroySortables();
    for (let chat of listEle.querySelectorAll(".risu-chat")) {
      chatsStb.push(
        new Sortable(chat, {
          group: "chats",
          draggable: "[data-chat-id][data-risu-chat-idx]",
          onStart: captureNavigation,
          onEnd: async (event) => {
            if (entityRuntimeEnabled) {
              await commitServerSort(event);
              return;
            }
            const currentChatPage = chara.chatPage;
            const newChats: Chat[] = [];

            // const chats: HTMLElement = event.to
            // chats.querySelectorAll()

            listEle
              .querySelectorAll("[data-risu-chat-folder-idx]")
              .forEach((folder) => {
                const folderIdx = parseInt(
                  folder.getAttribute("data-risu-chat-folder-idx"),
                );
                folder
                  .querySelectorAll("[data-risu-chat-idx]")
                  .forEach((chatInFolder) => {
                    const chatIdx = parseInt(
                      chatInFolder.getAttribute("data-risu-chat-idx"),
                    );
                    const newChat = chara.chats[chatIdx];
                    newChat.folderId = chara.chatFolders[folderIdx].id;
                    newChats.push(newChat);
                  });
              });

            listEle
              .querySelectorAll("[data-risu-chat-idx]")
              .forEach((chatEle) => {
                const idx = parseInt(
                  chatEle.getAttribute("data-risu-chat-idx"),
                );
                const newChat = chara.chats[idx];
                if (newChats.includes(newChat) == false) {
                  if (newChat.folderId != null) newChat.folderId = null;
                  newChats.push(newChat);
                }
              });

            changeChatTo(newChats.indexOf(chara.chats[currentChatPage]));
            chara.chats = newChats;

            try {
              this.destroy();
            } catch (e) {}
            sorted += 1;
            await sleep(1);
            createStb();
          },
          ...sortableOptions,
        }),
      );
    }
    folderStb = Sortable.create(folderEles, {
      group: "folders",
      draggable: "[data-chat-folder-id]",
      onStart: captureNavigation,
      onEnd: async (event) => {
        if (entityRuntimeEnabled) {
          await commitServerSort(event, true);
          return;
        }
        const newFolders: ChatFolder[] = [];
        const newChats: Chat[] = [];
        const folders: HTMLElement[] = Array.from<HTMLElement>(
          event.to.children,
        );

        const currentChatPage = chara.chatPage;

        folders.forEach((folder) => {
          const folderIdx = parseInt(
            folder.getAttribute("data-risu-chat-folder-idx"),
          );
          newFolders.push(chara.chatFolders[folderIdx]);

          folder.querySelectorAll("[data-risu-chat-idx]").forEach((chatEle) => {
            const idx = parseInt(chatEle.getAttribute("data-risu-chat-idx"));
            newChats.push(chara.chats[idx]);
          });
        });

        listEle.querySelectorAll("[data-risu-chat-idx]").forEach((chatEle) => {
          const idx = parseInt(chatEle.getAttribute("data-risu-chat-idx"));
          if (newChats.includes(chara.chats[idx]) == false) {
            newChats.push(chara.chats[idx]);
          }
        });

        chara.chatFolders = newFolders;
        changeChatTo(newChats.indexOf(chara.chats[currentChatPage]));
        chara.chats = newChats;
        try {
          folderStb.destroy();
        } catch (e) {}
        sorted += 1;
        await sleep(1);
        createStb();
      },
      ...sortableOptions,
    });
  };

  onMount(() => {
    mounted = true;
    createStb();
  });

  $effect(() => {
    if (!entityRuntimeEnabled) return;
    displayFolders.map((folder) => folder.id).join();
    displayChats.map((chat) => [chat.id, displayFolderId(chat)]).join();
    const token = ++rebuild;
    void tick().then(() => {
      if (mounted && token === rebuild) createStb();
    });
  });

  onDestroy(() => {
    mounted = false;
    if (folderStb) {
      try {
        folderStb.destroy();
      } catch (error) {}
    }
    chatsStb.map((stb) => {
      try {
        stb.destroy();
      } catch (error) {}
    });
  });
</script>

<div class="flex flex-col w-full h-[calc(100%-2rem)] max-h-[calc(100%-2rem)]">
  <Button
    className="relative bottom-2"
    onclick={async () => {
      if (entityRuntimeEnabled) {
        try {
          await browserRuntime().createChat(chara.chaId, {
            note: "",
            name: `New Chat ${chara.chats.length + 1}`,
            localLore: [],
            fmIndex: -1,
          });
        } catch (error) {
          reportRuntimeError(error);
        }
        return;
      }
      const cha = chara;
      const len = chara.chats.length;
      let chats = chara.chats;
      chats.unshift({
        message: [],
        note: "",
        name: `New Chat ${len + 1}`,
        localLore: [],
        fmIndex: -1,
        id: v4(),
      });
      if (cha.type === "group") {
        cha.characters.map((c) => {
          chats[len].message.push({
            saying: c,
            role: "char",
            data: findCharacterbyId(c).firstMessage,
          });
        });
      }
      chara.chats = chats;
      changeChatTo(0);
      $ReloadGUIPointer += 1;
    }}>{language.newChat}</Button
  >

  {#key sorted}
    <div class="flex flex-col mt-2 overflow-y-auto grow" bind:this={listEle}>
      <!-- folder div -->
      <div class="flex flex-col" bind:this={folderEles}>
        <!-- chat folder -->
        {#each displayFolders as folder, i (folder.id)}
          <div
            data-risu-chat-folder-idx={i}
            data-chat-folder-id={folder.id}
            class="flex flex-col mb-2 border-solid border-1 border-darkborderc cursor-pointer rounded-md"
          >
            <!-- folder header -->
            <button
              data-chat-folder-action="fold"
              aria-busy={!!navigation}
              onclick={() => {
                if (!editMode) {
                  changeFolder(chara, folder, "folded", !folder.folded);
                  if (!entityRuntimeEnabled) $ReloadGUIPointer += 1;
                }
              }}
              class="flex items-center text-textcolor border-solid border-0 border-darkborderc p-2 cursor-pointer rounded-md"
              class:bg-red-900={folder.color === "red"}
              class:bg-yellow-900={folder.color === "yellow"}
              class:bg-green-900={folder.color === "green"}
              class:bg-blue-900={folder.color === "blue"}
              class:bg-indigo-900={folder.color === "indigo"}
              class:bg-purple-900={folder.color === "purple"}
              class:bg-pink-900={folder.color === "pink"}
            >
              {#if editMode}
                <TextInput
                  bind:value={
                    () => folder.name,
                    (value) => changeFolder(chara, folder, "name", value)
                  }
                  className="grow min-w-0"
                  padding={false}
                />
              {:else}
                <span>{folder.name}</span>
              {/if}
              <div class="grow flex justify-end">
                <div
                  data-chat-folder-action="color"
                  role="button"
                  tabindex="0"
                  onkeydown={(e) => {
                    if (e.key === "Enter") {
                      e.currentTarget.click();
                    }
                  }}
                  class="text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
                  onclick={async (e) => {
                    e.stopPropagation();
                    const owner = chara,
                      target = entityRuntimeEnabled
                        ? captureFolderTarget(owner, folder.id)
                        : undefined;
                    if (entityRuntimeEnabled && !target) return;
                    const sel = parseInt(
                      await alertSelect([
                        language.changeFolderColor,
                        language.cancel,
                      ]),
                    );
                    switch (sel) {
                      case 0:
                        const colors = [
                          "red",
                          "green",
                          "blue",
                          "yellow",
                          "indigo",
                          "purple",
                          "pink",
                          "default",
                        ];
                        const sel = parseInt(await alertSelect(colors));
                        if (typeof colors[sel] === "string")
                          changeFolder(
                            owner,
                            folder,
                            "color",
                            colors[sel],
                            target,
                          );
                        break;
                    }
                  }}
                >
                  <MenuIcon size={18} />
                </div>
                <div
                  data-chat-folder-action="rename"
                  role="button"
                  tabindex="0"
                  onkeydown={(e) => {
                    if (e.key === "Enter") {
                      e.currentTarget.click();
                    }
                  }}
                  class="text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
                  onclick={(e) => {
                    e.stopPropagation();
                    editMode = !editMode;
                  }}
                >
                  <PencilIcon size={18} />
                </div>
                <div
                  data-chat-folder-action="remove"
                  role="button"
                  tabindex="0"
                  onkeydown={(e) => {
                    if (e.key === "Enter") {
                      e.currentTarget.click();
                    }
                  }}
                  class="text-textcolor2 hover:text-green-500 cursor-pointer"
                  onclick={async (e) => {
                    e.stopPropagation();
                    const target = entityRuntimeEnabled
                      ? captureFolderTarget(chara, folder.id)
                      : undefined;
                    if (entityRuntimeEnabled && !target) return;
                    const d = await alertConfirm(
                      `${language.removeConfirm}${folder.name}`,
                    );
                    if (d) {
                      if (entityRuntimeEnabled) {
                        try {
                          await browserRuntime().removeChatFolder(target);
                        } catch (error) {
                          reportRuntimeError(error);
                        }
                        return;
                      }
                      $ReloadGUIPointer += 1;
                      const folders = chara.chatFolders;
                      folders.splice(i, 1);
                      chara.chats.forEach((chat) => {
                        if (chat.folderId == folder.id) {
                          chat.folderId = null;
                        }
                      });
                      chara.chatFolders = folders;
                    }
                  }}
                >
                  <TrashIcon size={18} />
                </div>
              </div>
            </button>
            <!-- chats in folder -->
            <div
              class="risu-chat flex flex-col w-full text-textcolor border-solid border-0 border-darkborderc p-2 cursor-pointer rounded-md {folder.folded
                ? 'hidden'
                : ''}"
            >
              {#if displayChats.filter((chat) => displayFolderId(chat) == folder.id).length == 0}
                <span class="no-sort flex justify-center text-textcolor2"
                  >Empty</span
                >
                <div></div>
              {:else}
                {#each displayChats.filter((chat) => displayFolderId(chat) == folder.id) as chat (chat.id)}
                  <button
                    data-chat-id={chat.id}
                    data-risu-chat-idx={chara.chats.indexOf(chat)}
                    onclick={() => {
                      if (!editMode) {
                        changeChatTo(chara.chats.indexOf(chat));
                        $ReloadGUIPointer += 1;
                      }
                    }}
                    class="risu-chats flex items-center text-textcolor border-solid border-0 border-darkborderc p-2 cursor-pointer rounded-md"
                    class:bg-selected={chara.chats.indexOf(chat) ===
                      chara.chatPage}
                  >
                    {#if editMode}
                      <TextInput
                        bind:value={
                          () =>
                            getFieldValue(chatTarget(chat, "name"), chat.name),
                          (value) =>
                            setFieldValue(
                              chatTarget(chat, "name"),
                              value,
                              () => {
                                chat.name = value;
                              },
                            )
                        }
                        className="grow min-w-0"
                        padding={false}
                      />
                    {:else}
                      <span>{chat.name}</span>
                    {/if}
                    <div class="grow flex justify-end">
                      <div
                        role="button"
                        tabindex="0"
                        onkeydown={(e) => {
                          if (e.key === "Enter") {
                            e.currentTarget.click();
                          }
                        }}
                        class="text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
                        onclick={async () => {
                          const option = await alertChatOptions();
                          switch (option) {
                            case 0: {
                              if (entityRuntimeEnabled) {
                                await cloneServerChat(chat);
                                break;
                              }
                              const newChat = $state.snapshot(
                                chara.chats[chara.chats.indexOf(chat)],
                              );
                              newChat.name = createChatCopyName(
                                newChat.name,
                                "Copy",
                              );
                              newChat.id = v4();
                              chara.chats.unshift(newChat);
                              changeChatTo(0);
                              chara.chats = chara.chats;
                              break;
                            }
                            case 1: {
                              if (chat.bindedPersona) {
                                const confirm = await alertConfirm(
                                  language.doYouWantToUnbindCurrentPersona,
                                );
                                if (confirm) {
                                  chat.bindedPersona = "";
                                  alertNormal(language.personaUnbindedSuccess);
                                }
                              } else {
                                const confirm = await alertConfirm(
                                  language.doYouWantToBindCurrentPersona,
                                );
                                if (confirm) {
                                  if (
                                    !DBState.db.personas[
                                      DBState.db.selectedPersona
                                    ].id
                                  ) {
                                    DBState.db.personas[
                                      DBState.db.selectedPersona
                                    ].id = v4();
                                  }
                                  chat.bindedPersona =
                                    DBState.db.personas[
                                      DBState.db.selectedPersona
                                    ].id;
                                  console.log(
                                    DBState.db.personas[
                                      DBState.db.selectedPersona
                                    ],
                                  );
                                  alertNormal(language.personaBindedSuccess);
                                }
                              }
                              break;
                            }
                            case 2: {
                              changeChatTo(chara.chats.indexOf(chat));
                              createMultiuserRoom();
                            }
                          }
                        }}
                      >
                        <MenuIcon size={18} />
                      </div>
                      <div
                        role="button"
                        tabindex="0"
                        onkeydown={(e) => {
                          if (e.key === "Enter") {
                            e.currentTarget.click();
                          }
                        }}
                        class="text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
                        onclick={() => {
                          editMode = !editMode;
                        }}
                      >
                        <PencilIcon size={18} />
                      </div>
                      <div
                        role="button"
                        tabindex="0"
                        onkeydown={(e) => {
                          if (e.key === "Enter") {
                            e.currentTarget.click();
                          }
                        }}
                        class="text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
                        onclick={async (e) => {
                          e.stopPropagation();
                          exportChat(chara.chats.indexOf(chat));
                        }}
                      >
                        <DownloadIcon size={18} />
                      </div>
                      <div
                        role="button"
                        tabindex="0"
                        onkeydown={(e) => {
                          if (e.key === "Enter") {
                            e.currentTarget.click();
                          }
                        }}
                        class="text-textcolor2 hover:text-green-500 cursor-pointer"
                        onclick={async (e) => {
                          e.stopPropagation();
                          if (chara.chats.length === 1) {
                            alertError(language.errors.onlyOneChat);
                            return;
                          }
                          const d = await alertConfirm(
                            `${language.removeConfirm}${chat.name}`,
                          );
                          if (d) {
                            if (entityRuntimeEnabled) {
                              await removeServerChat(chat);
                              return;
                            }
                            changeChatTo(0);
                            $ReloadGUIPointer += 1;
                            let chats = chara.chats;
                            chats.splice(chara.chats.indexOf(chat), 1);
                            chara.chats = chats;
                          }
                        }}
                      >
                        <TrashIcon size={18} />
                      </div>
                    </div>
                  </button>
                {/each}
              {/if}
            </div>
          </div>
        {/each}
      </div>
      <!-- chat without folder div -->
      <div class="risu-chat flex flex-col">
        {#each displayChats as chat (chat.id)}
          {@const i = chara.chats.indexOf(chat)}
          {#if displayFolderId(chat) == null || (entityRuntimeEnabled && !displayFolders.some((folder) => folder.id === displayFolderId(chat)))}
            <button
              data-chat-id={chat.id}
              data-risu-chat-idx={i}
              onclick={() => {
                if (!editMode) {
                  changeChatTo(i);
                  $ReloadGUIPointer += 1;
                }
              }}
              class="flex items-center text-textcolor border-solid border-0 border-darkborderc p-2 cursor-pointer rounded-md"
              class:bg-selected={i === chara.chatPage}
            >
              {#if editMode}
                <TextInput
                  bind:value={
                    () => getFieldValue(chatTarget(chat, "name"), chat.name),
                    (value) =>
                      setFieldValue(chatTarget(chat, "name"), value, () => {
                        chat.name = value;
                      })
                  }
                  className="grow min-w-0"
                  padding={false}
                />
              {:else}
                <span>{chat.name}</span>
              {/if}
              <div class="grow flex justify-end">
                <div
                  role="button"
                  tabindex="0"
                  onkeydown={(e) => {
                    if (e.key === "Enter") {
                      e.currentTarget.click();
                    }
                  }}
                  class="text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
                  onclick={async () => {
                    const option = await alertChatOptions();
                    switch (option) {
                      case 0: {
                        if (entityRuntimeEnabled) {
                          await cloneServerChat(chat);
                          break;
                        }
                        const newChat = $state.snapshot(chara.chats[i]);
                        newChat.name = createChatCopyName(newChat.name, "Copy");
                        newChat.id = v4();
                        chara.chats.unshift(newChat);
                        changeChatTo(0);
                        chara.chats = chara.chats;
                        break;
                      }
                      case 1: {
                        const chat = chara.chats[i];
                        if (chat.bindedPersona) {
                          const confirm = await alertConfirm(
                            language.doYouWantToUnbindCurrentPersona,
                          );
                          if (confirm) {
                            chat.bindedPersona = "";
                            alertNormal(language.personaUnbindedSuccess);
                          }
                        } else {
                          const confirm = await alertConfirm(
                            language.doYouWantToBindCurrentPersona,
                          );
                          if (confirm) {
                            if (
                              !DBState.db.personas[DBState.db.selectedPersona]
                                .id
                            ) {
                              DBState.db.personas[
                                DBState.db.selectedPersona
                              ].id = v4();
                            }
                            chat.bindedPersona =
                              DBState.db.personas[
                                DBState.db.selectedPersona
                              ].id;
                            console.log(
                              DBState.db.personas[DBState.db.selectedPersona],
                            );
                            alertNormal(language.personaBindedSuccess);
                          }
                        }
                        break;
                      }
                      case 2: {
                        changeChatTo(i);
                        createMultiuserRoom();
                      }
                    }
                  }}
                >
                  <MenuIcon size={18} />
                </div>
                <div
                  role="button"
                  tabindex="0"
                  onkeydown={(e) => {
                    if (e.key === "Enter") {
                      e.currentTarget.click();
                    }
                  }}
                  class="text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
                  onclick={() => {
                    editMode = !editMode;
                  }}
                >
                  <PencilIcon size={18} />
                </div>
                <div
                  role="button"
                  tabindex="0"
                  onkeydown={(e) => {
                    if (e.key === "Enter") {
                      e.currentTarget.click();
                    }
                  }}
                  class="text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
                  onclick={async (e) => {
                    e.stopPropagation();
                    exportChat(i);
                  }}
                >
                  <DownloadIcon size={18} />
                </div>
                <div
                  role="button"
                  tabindex="0"
                  onkeydown={(e) => {
                    if (e.key === "Enter") {
                      e.currentTarget.click();
                    }
                  }}
                  class="text-textcolor2 hover:text-green-500 cursor-pointer"
                  onclick={async (e) => {
                    e.stopPropagation();
                    if (chara.chats.length === 1) {
                      alertError(language.errors.onlyOneChat);
                      return;
                    }
                    const d = await alertConfirm(
                      `${language.removeConfirm}${chat.name}`,
                    );
                    if (d) {
                      if (entityRuntimeEnabled) {
                        await removeServerChat(chat);
                        return;
                      }
                      changeChatTo(0);
                      $ReloadGUIPointer += 1;
                      let chats = chara.chats;
                      chats.splice(i, 1);
                      chara.chats = chats;
                    }
                  }}
                >
                  <TrashIcon size={18} />
                </div>
              </div>
            </button>
          {/if}
        {/each}
      </div>
    </div>
  {/key}

  <div class="border-t border-selected mt-2">
    <div class="flex mt-2 ml-2 items-center">
      <button
        class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
        onclick={() => {
          exportAllChats();
        }}
      >
        <DownloadIcon size={18} />
      </button>
      <button
        class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
        onclick={() => {
          importChat();
        }}
      >
        <HardDriveUploadIcon size={18} />
      </button>
      <button
        class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
        onclick={() => {
          editMode = !editMode;
        }}
      >
        <PencilIcon size={18} />
      </button>
      <button
        class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
        onclick={() => {
          alertStore.set({
            type: "branches",
            msg: "",
          });
        }}
      >
        <SplitIcon size={18} />
      </button>
      <button
        class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer button-open-bookmarks"
        title={language.bookmarks}
        onclick={() => {
          $bookmarkListOpen = true;
        }}
      >
        <BookmarkCheckIcon size={18} />
      </button>
      <button
        class="ml-auto text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
        data-chat-folder-action="add"
        onclick={() => {
          if (entityRuntimeEnabled) {
            try {
              const target = browserRuntime().captureChatFolder(
                  chara.chaId,
                  "",
                ),
                folders = folderValues(chara);
              browserRuntime().setChatFolders(
                target,
                JSON.parse(
                  commandJson([
                    {
                      id: v4(),
                      name: `New Folder ${folders.length + 1}`,
                      folded: false,
                    },
                    ...folders,
                  ]),
                ),
              );
            } catch (error) {
              reportRuntimeError(error);
            }
            return;
          }
          if (!chara.chatFolders) {
            chara.chatFolders = [];
          }
          const folders = chara.chatFolders;
          const length = chara.chatFolders.length;
          folders.unshift({
            id: v4(),
            name: `New Folder ${length + 1}`,
            folded: false,
          });
          chara.chatFolders = folders;
          $ReloadGUIPointer += 1;
        }}
      >
        <FolderPlusIcon size={18} />
      </button>
    </div>

    {#if DBState.db.characters[$selectedCharID]?.chaId !== "§playground"}
      <Toggles bind:chara />
    {/if}
  </div>
  {#if chara.type === "group"}
    <div class="flex mt-2 items-center">
      <CheckInput
        bind:check={
          () =>
            getFieldValue(
              {
                scope: "character",
                entityId: chara.chaId,
                key: "orderByOrder",
              },
              (chara as groupChat).orderByOrder,
            ),
          (value) =>
            setFieldValue(
              {
                scope: "character",
                entityId: chara.chaId,
                key: "orderByOrder",
              },
              value,
              () => {
                if (chara.type === "group") chara.orderByOrder = value;
              },
            )
        }
        name={language.orderByOrder}
      />
    </div>
  {/if}
</div>
