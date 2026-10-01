/** One save worker, many mutation producers. Coalesce requests while the
 * worker is busy and retain a notification received before it starts waiting. */
export class SaveWakeSignal {
    private pending = false
    private wake: (() => void) | null = null

    notify() {
        this.pending = true
        this.wake?.()
        this.wake = null
    }

    async wait() {
        if (!this.pending) {
            await new Promise<void>((resolve) => {
                this.wake = resolve
            })
        }
        this.pending = false
    }
}
