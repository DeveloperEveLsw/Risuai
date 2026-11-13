export type JobHistoryOwner = {
  chatId: string;
  chatEpoch: number;
  selection: number;
};
export type JobHistoryFilter = "all" | "memory" | "failed";
export type JobHistoryItem = {
  id: string;
  chatId: string;
  chatEpoch: number;
  type: string;
  state: string;
  queuePosition: number;
  fence: number;
  progressRevision: number;
  cancelRequested: boolean;
  resultAvailable: boolean;
  createdAt: number;
  updatedAt: number;
};
export type JobHistoryPage = {
  chatId: string;
  chatEpoch: number;
  filter: JobHistoryFilter;
  upper: number;
  cursor: number;
  items: JobHistoryItem[];
  older: string | null;
  newer: string | null;
};
export type JobHistoryState = {
  page: JobHistoryPage | null;
  loading: boolean;
  error: string;
  filter: JobHistoryFilter;
};
type Host = {
  owner: () => JobHistoryOwner | null;
  read: (
    owner: JobHistoryOwner,
    filter: JobHistoryFilter,
    after: string | undefined,
    signal: AbortSignal,
  ) => Promise<JobHistoryPage>;
  publish: (state: JobHistoryState) => void;
};
const equal = (a?: JobHistoryOwner | null, b?: JobHistoryOwner | null) =>
  a &&
  b &&
  a.chatId === b.chatId &&
  a.chatEpoch === b.chatEpoch &&
  a.selection === b.selection;
/** An open dialog owns one metadata page, two cursor strings and one request. */
export class JobHistory {
  private owner?: JobHistoryOwner;
  private token = 0;
  private request?: AbortController;
  private state: JobHistoryState = {
    page: null,
    loading: false,
    error: "",
    filter: "all",
  };
  constructor(private host: Host) {}
  current() {
    return Boolean(equal(this.owner, this.host.owner()));
  }
  close() {
    this.token++;
    this.request?.abort();
    this.request = undefined;
    this.owner = undefined;
    this.state = { ...this.state, page: null, loading: false, error: "" };
    this.host.publish(this.state);
  }
  async open(filter: JobHistoryFilter = "all") {
    this.close();
    const owner = this.host.owner();
    if (!owner) return;
    this.owner = { ...owner };
    await this.refresh(filter);
  }
  async refresh(filter = this.state.filter) {
    return this.load(filter);
  }
  async older() {
    if (!this.state.loading && this.state.page?.older)
      return this.load(this.state.filter, this.state.page.older);
  }
  async newer() {
    if (!this.state.loading && this.state.page?.newer)
      return this.load(this.state.filter, this.state.page.newer);
  }
  private async load(filter: JobHistoryFilter, after?: string) {
    if (!this.current()) {
      this.close();
      return;
    }
    const owner = { ...this.owner },
      token = ++this.token;
    this.request?.abort();
    const request = (this.request = new AbortController());
    // Old rows must not remain actionable under another filter or failed read.
    this.state = { page: null, filter, loading: true, error: "" };
    this.host.publish(this.state);
    try {
      const page = await this.host.read(owner, filter, after, request.signal);
      if (token !== this.token || !this.current()) return;
      if (
        page.chatId !== owner.chatId ||
        page.chatEpoch !== owner.chatEpoch ||
        page.filter !== filter ||
        page.items.length > 20 ||
        page.items.some(
          (item) =>
            item.chatId !== owner.chatId || item.chatEpoch !== owner.chatEpoch,
        )
      )
        throw Error("Job history response does not match its captured view");
      this.state = { page, filter, loading: false, error: "" };
    } catch (error) {
      if (token !== this.token || !this.current()) return;
      this.state = {
        page: null,
        filter,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (token === this.token) {
        this.request = undefined;
        if (!this.current()) this.close();
        else this.host.publish(this.state);
      }
    }
  }
}
