export type RouterTier = 'haiku' | 'sonnet' | 'opus' | 'fable'

export type RouterEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** What the router applies to every main-thread request until the next prompt. */
export type RouterRoute = {
  tier: RouterTier
  model: string
  effort: RouterEffort
  reason: string
  source: 'classifier' | 'pin' | 'inline'
  /** Who decided, for the card: `Jev`, `OpenAI Decisions`, `Haiku · your plan`, ... */
  classifier: string
}

/** What the person fixed with `/router pin`; the classifier picks whatever is absent. */
export type RouterPin = { tier?: RouterTier; effort?: RouterEffort }

/**
 * The card drawn under one prompt: the route it got, or, when nothing could
 * decide, the route kept (`kept` says why; `route` absent means the default).
 */
export type RouterCard = {
  seq: number
  /** The prompt row's transcript id, once the row is stored. */
  id?: string
  /** The prompt's text, whitespace folded, for a row whose id never arrived. */
  key: string
  route?: RouterRoute
  kept?: string
}

/** A provider family whose key can be saved from the keys pane. */
export type RouterKeySlot = 'typesafe' | 'openai' | 'anthropic'

/** The outcome of the pane's live check of one key. */
export type RouterKeyCheck = { state: 'checking' | 'ok' | 'failed'; text: string }

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      route: RouterRoute | null
      pin: RouterPin | null
      isPaused: boolean
      lastError: string | null
      cards: RouterCard[]
      keyChecks: Partial<Record<RouterKeySlot, RouterKeyCheck>>
      /** Bumped on every save or removal, so the pane's fields come back empty. */
      keyVersion: number
    }
  }
}
