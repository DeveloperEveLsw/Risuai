/** One running preparation and one replaceable successor per rendered row.
 * Only pending presentations are retired; already running original Lua stays
 * ordered in its existing VM. No canonical operation is scheduled here.
 */
export class DisplayPreparationQueue {
  private active = false;
  private closed = false;
  private pending?: (release?: () => void) => void;

  enter(): Promise<(() => void) | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    if (!this.active) {
      this.active = true;
      return Promise.resolve(this.release());
    }
    this.pending?.();
    return new Promise((resolve) => (this.pending = resolve));
  }

  private release() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.pending;
      this.pending = undefined;
      if (next && !this.closed) next(this.release());
      else this.active = false;
    };
  }

  close() {
    this.closed = true;
    this.pending?.();
    this.pending = undefined;
  }
}
