/** Ephemeral feedback belongs to the clicked control, never to the saved
 * character HTML. Preserve community accessibility attributes on completion. */
export function beginChatMarkupPending(origin: Element): (() => void) | null {
    if (origin.hasAttribute('data-risu-interaction-pending')) return null
    const previousBusy = origin.getAttribute('aria-busy')
    origin.setAttribute('data-risu-interaction-pending', '')
    origin.setAttribute('aria-busy', 'true')
    return () => {
        origin.removeAttribute('data-risu-interaction-pending')
        if (previousBusy === null) origin.removeAttribute('aria-busy')
        else origin.setAttribute('aria-busy', previousBusy)
    }
}
