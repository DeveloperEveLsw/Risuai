export type DisplayRenderTicket = Readonly<{
  source: string;
  key: string;
  rendered: string;
}>;
type Entry = {
  ticket: DisplayRenderTicket;
  bytes: number;
  sanitizeInput?: string;
  sanitizeKey?: string;
  sanitized?: string;
};
const cssMarker = /<risu-style/i;
const retainedBytes = (...strings: string[]) =>
  strings.reduce((n, value) => n + value.length * 2, 0);

/** Bound retained immutable strings across owners, without retaining scopes,
 * drafts, DOM nodes, assets or completed presentation promises.
 */
export class DisplayRenderCachePool {
  private entries = new Map<DisplayRenderCache, Entry>();
  private bytes = 0;
  private counts = {
    markdownHits: 0,
    markdownMisses: 0,
    sanitizeHits: 0,
    sanitizeMisses: 0,
    cssBypasses: 0,
    evictions: 0,
  };
  constructor(
    private maxBytes = 16 * 1024 * 1024,
    private maxOwners = 256,
    private maxOwnerBytes = 512 * 1024,
  ) {
    for (const limit of [maxBytes, maxOwners, maxOwnerBytes])
      if (!Number.isSafeInteger(limit) || limit < 0)
        throw Error("Invalid display render cache budget");
  }
  private touch(owner: DisplayRenderCache, entry: Entry) {
    this.entries.delete(owner);
    this.entries.set(owner, entry);
  }
  private reserve(owner: DisplayRenderCache, entry: Entry) {
    this.forget(owner);
    if (
      this.maxOwners === 0 ||
      entry.bytes > this.maxBytes ||
      entry.bytes > this.maxOwnerBytes
    )
      return false;
    while (
      this.entries.size &&
      (this.entries.size >= this.maxOwners ||
        this.bytes + entry.bytes > this.maxBytes)
    ) {
      this.forget(this.entries.keys().next().value);
      this.counts.evictions++;
    }
    this.entries.set(owner, entry);
    this.bytes += entry.bytes;
    return true;
  }
  lookup(owner: DisplayRenderCache, source: string, key: string) {
    const entry = this.entries.get(owner);
    if (entry?.ticket.source === source && entry.ticket.key === key) {
      this.touch(owner, entry);
      this.counts.markdownHits++;
      return entry.ticket;
    }
    this.counts.markdownMisses++;
  }
  remember(
    owner: DisplayRenderCache,
    source: string,
    key: string,
    rendered: string,
  ) {
    const ticket = Object.freeze({ source, key, rendered });
    return this.reserve(owner, {
      ticket,
      bytes: retainedBytes(source, key, rendered),
    })
      ? ticket
      : undefined;
  }
  sanitized(
    owner: DisplayRenderCache,
    ticket: DisplayRenderTicket,
    input: string,
    key: string,
  ) {
    // CSS CBS must execute on every owner and contribute its current read CAS.
    if (cssMarker.test(input)) {
      this.counts.cssBypasses++;
      return;
    }
    const entry = this.entries.get(owner);
    if (
      entry?.ticket === ticket &&
      entry.sanitizeInput === input &&
      entry.sanitizeKey === key
    ) {
      this.touch(owner, entry);
      this.counts.sanitizeHits++;
      return entry.sanitized;
    }
    this.counts.sanitizeMisses++;
  }
  rememberSanitized(
    owner: DisplayRenderCache,
    ticket: DisplayRenderTicket,
    input: string,
    key: string,
    sanitized: string,
  ) {
    const entry = this.entries.get(owner);
    if (entry?.ticket !== ticket || cssMarker.test(input)) return;
    this.reserve(owner, {
      ticket,
      sanitizeInput: input,
      sanitizeKey: key,
      sanitized,
      bytes: retainedBytes(
        ticket.source,
        ticket.key,
        ticket.rendered,
        input,
        key,
        sanitized,
      ),
    });
  }
  forget(owner: DisplayRenderCache) {
    const entry = this.entries.get(owner);
    if (entry) {
      this.bytes -= entry.bytes;
      this.entries.delete(owner);
    }
  }
  diagnostics() {
    return {
      owners: this.entries.size,
      retainedBytes: this.bytes,
      ...this.counts,
    };
  }
}

const sharedPool = new DisplayRenderCachePool();
export const displayRenderCacheDiagnostics = () => sharedPool.diagnostics();

/** One last rendered input per mounted ChatBody; closing fences late async work. */
export class DisplayRenderCache {
  private closed = false;
  constructor(private pool = sharedPool) {}
  lookup(source: string, key: string) {
    return this.closed ? undefined : this.pool.lookup(this, source, key);
  }
  remember(source: string, key: string, rendered: string) {
    return this.closed
      ? undefined
      : this.pool.remember(this, source, key, rendered);
  }
  sanitized(ticket: DisplayRenderTicket, input: string, key: string) {
    return this.closed
      ? undefined
      : this.pool.sanitized(this, ticket, input, key);
  }
  rememberSanitized(
    ticket: DisplayRenderTicket,
    input: string,
    key: string,
    sanitized: string,
  ) {
    if (!this.closed)
      this.pool.rememberSanitized(this, ticket, input, key, sanitized);
  }
  close() {
    this.closed = true;
    this.pool.forget(this);
  }
}
