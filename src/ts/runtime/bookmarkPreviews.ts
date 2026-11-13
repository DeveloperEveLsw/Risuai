import type { Message } from "../storage/database.svelte";
import type { DisplayMessageOrigin } from "./displayEffects";
import type { Json, RuntimeChange } from "./clientProtocol";

export type BookmarkPreviewOwner = {
  chatId: string;
  characterId: string;
  epoch: number;
  selection: number;
};
export type BookmarkPreviewItem = {
  messageId: string;
  bookmarkRevision: number;
  messageRevision: number;
  position: number;
  ordinal: number;
  nameExists: boolean;
  name?: Json;
  message: Message;
  displayOrigin?: DisplayMessageOrigin;
};
export type BookmarkPreviewPage = {
  chatId: string;
  entityEpoch: number;
  cursor: number;
  collectionRevision: number;
  contentRevision: number;
  count: number;
  historyCount: number;
  items: BookmarkPreviewItem[];
  next: string | null;
};
export type BookmarkPreviewState = {
  session: string;
  presentationToken: string;
  items: BookmarkPreviewItem[];
  count: number;
  next: string | null;
  first: boolean;
  loading: boolean;
  ready: boolean;
};
type Host = {
  owner: () => BookmarkPreviewOwner | undefined;
  projectedCursor: () => number;
  read: (path: string) => Promise<BookmarkPreviewPage>;
  publish: (state: BookmarkPreviewState) => void;
};
const sameOwner = (a: BookmarkPreviewOwner, b?: BookmarkPreviewOwner) =>
  b &&
  a.chatId === b.chatId &&
  a.characterId === b.characterId &&
  a.epoch === b.epoch &&
  a.selection === b.selection;

/** One bounded page owned by an open list. Bodies never enter main DBState. */
export class BookmarkPreviews {
  private session = "";
  private owner?: BookmarkPreviewOwner;
  private page?: BookmarkPreviewPage;
  private generation = 0;
  private floor = 0;
  private after?: string;
  private loading = false;
  constructor(private host: Host) {}
  open() {
    this.close();
    this.owner = this.host.owner();
    if (!this.owner) throw Error("Select a saved conversation first");
    this.session = crypto.randomUUID();
    this.publish();
    return this.session;
  }
  close(session = this.session) {
    if (session !== this.session) return;
    this.generation++;
    this.session = "";
    this.owner = undefined;
    this.page = undefined;
    this.after = undefined;
    this.floor = 0;
    this.loading = false;
    this.publish();
  }
  private publish() {
    const ready = Boolean(this.current());
    this.host.publish({
      session: this.session,
      presentationToken: ready ? this.session + ":" + this.generation : "",
      items: ready ? this.page.items : [],
      count: this.page?.count ?? 0,
      next: ready ? this.page.next : null,
      first: this.after === undefined,
      loading: this.loading || Boolean(this.page && !ready),
      ready,
    });
  }
  current(session = this.session) {
    return this.session &&
      session === this.session &&
      this.owner &&
      sameOwner(this.owner, this.host.owner()) &&
      this.page &&
      this.page.entityEpoch === this.owner.epoch &&
      this.page.cursor >= this.floor &&
      this.page.cursor <= this.host.projectedCursor()
      ? this.page
      : undefined;
  }
  item(id: string, session = this.session) {
    return this.current(session)?.items.find((item) => item.messageId === id);
  }
  presentation(token: string) {
    return token === this.session + ":" + this.generation
      ? this.current()
      : undefined;
  }
  owns(session: string, item: BookmarkPreviewItem) {
    return this.item(item.messageId, session) === item;
  }
  observe(change: RuntimeChange) {
    if (!this.owner || !this.session) return false;
    const p = change.payload;
    const relevant =
      (change.chatId === this.owner.chatId &&
        [
          "bookmark",
          "message",
          "messages-removed",
          "reply-batch",
          "message-order",
          "message-disabled",
        ].includes(change.type)) ||
      (change.type === "chat" && change.id === this.owner.chatId) ||
      (change.type === "fields" &&
        Array.isArray(p.fields) &&
        p.fields.some(
          (field: any) =>
            field.scope === "chat" &&
            field.entityId === this.owner.chatId &&
            ["bookmarks", "bookmarkNames"].includes(field.key),
        ));
    if (!relevant) return false;
    this.floor = Math.max(this.floor, change.sequence);
    // A read ahead of projection already includes this journal event.
    if ((this.page?.cursor ?? -1) >= this.floor) return false;
    this.page = undefined;
    this.after = undefined;
    this.generation++;
    this.loading = false;
    this.publish();
    return true;
  }
  projected() {
    if (this.session && !sameOwner(this.owner, this.host.owner())) {
      this.close();
      return;
    }
    this.publish();
  }
  async load(session: string, after?: string) {
    if (session !== this.session || !this.owner) return;
    const owner = this.owner;
    const generation = ++this.generation;
    this.page = undefined;
    this.after = after;
    this.loading = true;
    this.publish();
    const alive = () =>
      generation === this.generation &&
      session === this.session &&
      sameOwner(owner, this.host.owner());
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        let page: BookmarkPreviewPage;
        try {
          page = await this.host.read(
            "/chats/" +
              encodeURIComponent(owner.chatId) +
              "/bookmarks?limit=100" +
              (after === undefined
                ? ""
                : "&after=" + encodeURIComponent(after)),
          );
        } catch (error) {
          if (!alive()) return;
          if (
            after !== undefined &&
            (error as { code?: string }).code === "PAGE_CHANGED"
          ) {
            after = undefined;
            this.after = undefined;
            continue;
          }
          throw error;
        }
        if (!alive()) return;
        if (page.chatId !== owner.chatId || page.entityEpoch !== owner.epoch)
          throw Error(
            "Bookmark page belongs to another conversation incarnation",
          );
        if (page.cursor < this.floor) {
          after = undefined;
          this.after = undefined;
          continue;
        }
        if (
          page.items.length > 100 ||
          new Set(page.items.map((item) => item.messageId)).size !==
            page.items.length ||
          page.items.some(
            (item) =>
              item.message.chatId !== item.messageId ||
              !Number.isSafeInteger(item.ordinal) ||
              item.ordinal < 0 ||
              item.ordinal >= page.historyCount,
          )
        )
          throw Error("Invalid canonical bookmark page");
        this.page = page;
        return;
      }
      throw Error("Bookmarks changed repeatedly; reopen the list");
    } finally {
      if (alive()) {
        this.loading = false;
        this.publish();
      }
    }
  }
}
