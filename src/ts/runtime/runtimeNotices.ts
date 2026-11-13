import type { RuntimeChange } from "./clientProtocol";

export interface RuntimeNoticeHeader {
  id: string;
  jobId: string;
  chatId: string;
  chatEpoch: number;
  position: number;
  revision: number;
  unread: boolean;
  createdAt: number;
}
export interface RuntimeNoticeState {
  count: number;
  current: (RuntimeNoticeHeader & { message?: string }) | null;
  loading: boolean;
  error: string;
}
interface Page {
  cursor: number;
  count: number;
  items: RuntimeNoticeHeader[];
  next: number | null;
}

/** Separate global notification queue. Old HTTP responses cannot revive a peer acknowledgement. */
export class RuntimeNotices {
  private generation = 0;
  private floor = 0;
  private closed = false;
  private draining?: Promise<void>;
  private requested = false;
  private state: RuntimeNoticeState = {
    count: 0,
    current: null,
    loading: false,
    error: "",
  };
  constructor(
    private ports: {
      read: (path: string) => Promise<unknown>;
      publish: (state: RuntimeNoticeState) => void;
    },
  ) {}
  observe(change: RuntimeChange) {
    if (change.type === "notice") this.refresh(change.sequence);
  }
  refresh(floor = 0) {
    if (this.closed) return Promise.resolve();
    this.floor = Math.max(floor, this.floor);
    this.generation++;
    this.requested = true;
    if (!this.draining)
      this.draining = this.drain().finally(() => {
        this.draining = undefined;
      });
    return this.draining;
  }
  private publish(patch: Partial<RuntimeNoticeState>) {
    this.state = { ...this.state, ...patch };
    this.ports.publish(this.state);
  }
  private async drain() {
    while (this.requested && !this.closed) {
      this.requested = false;
      const generation = this.generation;
      const current = () => !this.closed && generation === this.generation;
      this.publish({ loading: true, error: "" });
      try {
        const page = (await this.ports.read("/notices?limit=20")) as Page;
        if (!current()) continue;
        if (page.cursor < this.floor)
          throw new Error(
            "Notification view is older than confirmed changes; retry.",
          );
        const head = page.items[0] ?? null;
        const saved = this.state.current;
        this.publish({
          count: page.count,
          current:
            head && saved?.id === head.id && saved.revision === head.revision
              ? saved
              : head,
        });
        if (head && this.state.current?.message === undefined) {
          const value = (await this.ports.read(
            "/notices/" + encodeURIComponent(head.id),
          )) as {
            cursor: number;
            notice: RuntimeNoticeHeader & { message: string };
          };
          if (!current()) continue;
          if (
            value.cursor < page.cursor ||
            !value.notice.unread ||
            value.notice.id !== head.id ||
            value.notice.revision !== head.revision
          ) {
            this.requested = true;
            continue;
          }
          this.publish({ current: value.notice });
        }
      } catch (error) {
        if (current())
          this.publish({
            error: error instanceof Error ? error.message : String(error),
          });
      } finally {
        if (current()) this.publish({ loading: false });
      }
    }
  }
  close() {
    this.closed = true;
    this.generation++;
    this.publish({ count: 0, current: null, loading: false, error: "" });
  }
}
