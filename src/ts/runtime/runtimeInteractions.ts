import type { RuntimeChange } from "./clientProtocol";

export interface RuntimeInteractionHeader {
  id: string;
  jobId: string;
  chatId: string;
  chatEpoch: number;
  position: number;
  kind: "input" | "select" | "confirm";
  state: "pending" | "answered" | "closed";
  revision: number;
  createdAt: number;
  closedReason: string | null;
}
export interface RuntimeInteractionDescriptor {
  kind: RuntimeInteractionHeader["kind"];
  prompt: string;
  defaultValue?: string;
  datalist?: [string, string][];
  options?: string[];
}
export interface RuntimeInteractionState {
  count: number;
  current:
    | (RuntimeInteractionHeader & { descriptor?: RuntimeInteractionDescriptor })
    | null;
  loading: boolean;
  error: string;
}
interface Page {
  cursor: number;
  count: number;
  items: RuntimeInteractionHeader[];
  next: number | null;
}

/** Global pending interactions; late reads cannot revive a peer's answered/closed prompt. */
export class RuntimeInteractions {
  private generation = 0;
  private floor = 0;
  private closed = false;
  private draining?: Promise<void>;
  private requested = false;
  private state: RuntimeInteractionState = {
    count: 0,
    current: null,
    loading: false,
    error: "",
  };
  constructor(
    private ports: {
      read: (path: string) => Promise<unknown>;
      publish: (state: RuntimeInteractionState) => void;
    },
  ) {}
  observe(change: RuntimeChange) {
    if (change.type === "interaction") this.refresh(change.sequence);
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
  private publish(patch: Partial<RuntimeInteractionState>) {
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
        const page = (await this.ports.read("/interactions?limit=20")) as Page;
        if (!current()) continue;
        if (page.cursor < this.floor)
          throw new Error(
            "Interaction view is older than confirmed changes; retry.",
          );
        const head = page.items[0] ?? null,
          saved = this.state.current;
        this.publish({
          count: page.count,
          current:
            head && saved?.id === head.id && saved.revision === head.revision
              ? saved
              : head,
        });
        if (head && !this.state.current?.descriptor) {
          const value = (await this.ports.read(
            "/interactions/" + encodeURIComponent(head.id),
          )) as {
            cursor: number;
            interaction: RuntimeInteractionHeader & {
              descriptor: RuntimeInteractionDescriptor;
            };
          };
          if (!current()) continue;
          if (
            value.cursor < page.cursor ||
            value.interaction.state !== "pending" ||
            value.interaction.id !== head.id ||
            value.interaction.revision !== head.revision
          ) {
            this.requested = true;
            continue;
          }
          this.publish({ current: value.interaction });
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
