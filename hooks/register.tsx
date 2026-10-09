import { atom, read, update } from 'claude-code'
import type { EngineInterface, HttpResponse, PromptSubmitInput, Register } from 'claude-code'

import type { RouterCard, RouterKeyCheck, RouterKeySlot, RouterPin, RouterRoute } from '../types'
import { bandView, cardKey, cardSvg, cardView, effortGlyphs, headerSvg } from './card'
import {
  EFFORTS,
  TIERS,
  availableTiers,
  capEffort,
  classifierLabel,
  classifierModel,
  classifierRequest,
  isOpenRouter,
  isSameModel,
  modelLabel,
  pickerOption,
  nearestTier,
  parseInline,
  planRequest,
  KEY_SLOTS,
  SLOT_PROVIDER,
  keyProblem,
  readHttpReply,
  readPlanReply,
  readSettings,
  settle,
  setupProblem,
  slotForKey,
  slotForProvider,
  timeoutProblem,
  withProvider,
  PROVIDERS,
} from './classify'
import type { ClassifierRequest, ClassifyInput, ClassifyOutcome, InlineChoice, KeySource, Settings } from './classify'

const route = atom({ plugin: 'model-router', key: 'route' } as const, null)
const pin = atom({ plugin: 'model-router', key: 'pin' } as const, null)
const isPaused = atom({ plugin: 'model-router', key: 'isPaused' } as const, false)
const lastError = atom({ plugin: 'model-router', key: 'lastError' } as const, null)
const cards = atom({ plugin: 'model-router', key: 'cards' } as const, [])
const keyChecks = atom({ plugin: 'model-router', key: 'keyChecks' } as const, {})
const keyVersion = atom({ plugin: 'model-router', key: 'keyVersion' } as const, 0)

/** The keys pane, and where the keys saved from it are kept: this plugin's own store. */
const KEYS_PANE = 'router-keys'
const KEYS_STORE = 'keys'

/** How many prompts keep their card; older rows draw as the engine has them. */
const CARD_LIMIT = 80

const KEY_SOURCES: Record<KeySource, string> = {
  saved: 'key saved with /router keys',
  config: 'key from the install screen',
  MODEL_ROUTER_API_KEY: 'key from MODEL_ROUTER_API_KEY',
  ANTHROPIC_API_KEY: 'key from ANTHROPIC_API_KEY',
  OPENAI_API_KEY: 'key from OPENAI_API_KEY',
  OPENROUTER_API_KEY: 'key from OPENROUTER_API_KEY',
  TYPESAFE_API_KEY: 'key from TYPESAFE_API_KEY',
}

const HELP = [
  'Every prompt you send is routed. These let you look and steer:',
  '  /router                      what was picked last, and why',
  '  /router keys                 add, test or remove API keys, and choose the classifier',
  '  /router test <prompt>        what a prompt would get, without sending it',
  '  /router pin opus [high]      always use a model (and effort); the classifier fills in the rest',
  '  /router pin high             always use an effort; the classifier picks the model',
  '  /router unpin                let the classifier decide again',
  '  /router off | on             pause or resume routing',
  '',
  'For one prompt only, start it with [opus], [high] or [sonnet low].',
].join('\n')

/** A route to apply, or why nothing could decide. */
type Decision = { route: RouterRoute } | { error: string }

/** The classifier a prompt asks, its key, and anything stopping it. */
type Classifier = { settings: Settings; key?: string; source?: KeySource; problem?: string }

/** The prompt that just got a card, until its row is stored and the card learns the row's id. */
let pendingSeq: number | undefined

function routeLabel(chosen: RouterRoute): string {
  return `${modelLabel(chosen.model)} · ${chosen.effort}`
}

/** The status line under the prompt, in Claude's own spark-and-dot style. */
function statusLine(chosen: RouterRoute | null, paused: boolean): string | undefined {
  if (paused) return '✻ routing paused · /router on'
  if (chosen === null) return undefined
  const tag = chosen.source === 'pin' ? ' · pinned' : chosen.source === 'inline' ? ' · your pick' : ''
  return `✻ ${routeLabel(chosen)}${tag}`
}

function parseChoice(words: readonly string[]): InlineChoice | undefined {
  const choice: InlineChoice = {}
  for (const word of words) {
    const lower = word.toLowerCase()
    const tier = TIERS.find(one => one === lower)
    const effort = EFFORTS.find(one => one === lower)
    if (tier !== undefined && choice.tier === undefined) choice.tier = tier
    else if (effort !== undefined && choice.effort === undefined) choice.effort = effort
    else return undefined
  }
  return choice.tier === undefined && choice.effort === undefined ? undefined : choice
}

/** What a prompt asks, for the classifier: its text, or a word for a prompt that is all attachments. */
function promptText(e: PromptSubmitInput): string {
  if (e.text.trim() !== '') return e.text
  return (e.attachments?.length ?? 0) > 0 ? '(attachments only, no text)' : ''
}

function findCard(list: readonly RouterCard[], id: string, key: string): RouterCard | undefined {
  const byId = list.find(card => card.id !== undefined && card.id === id)
  if (byId !== undefined) return byId
  for (let at = list.length - 1; at >= 0; at -= 1) {
    const card = list[at]
    if (card !== undefined && card.id === undefined && card.key === key) return card
  }
  return undefined
}

type FoundKey = { key: string; source: KeySource }

/** The keys saved from the pane, from this plugin's own store. */
async function readSavedKeys($: EngineInterface): Promise<Partial<Record<RouterKeySlot, string>>> {
  const stored = await $.store.get(KEYS_STORE)
  const keys: Partial<Record<RouterKeySlot, string>> = {}
  if (stored === null || typeof stored !== 'object') return keys
  for (const slot of KEY_SLOTS) {
    const value = (stored as Record<string, unknown>)[slot]
    if (typeof value === 'string' && value !== '') keys[slot] = value
  }
  return keys
}

/**
 * Every key the person has, by slot, each from the first place it is found:
 * saved from the pane, the install screen, MODEL_ROUTER_API_KEY, then the
 * provider's own environment variable.
 */
async function availableKeys($: EngineInterface, settings: Settings): Promise<Partial<Record<RouterKeySlot, FoundKey>>> {
  const found: Partial<Record<RouterKeySlot, FoundKey>> = {}
  const offer = (slot: RouterKeySlot, key: string | undefined, source: KeySource) => {
    const trimmed = key?.trim()
    if (trimmed && found[slot] === undefined) found[slot] = { key: trimmed, source }
  }
  // A key pasted on the install screen, or in MODEL_ROUTER_API_KEY, belongs to the provider chosen; under auto, to its prefix's.
  const slotOf = (key: string) => (settings.provider === 'auto' ? slotForKey(key) : (slotForProvider(settings) ?? slotForKey(key)))
  const saved = await readSavedKeys($)
  for (const slot of KEY_SLOTS) offer(slot, saved[slot], 'saved')
  if (settings.apiKey !== '') offer(slotOf(settings.apiKey), settings.apiKey, 'config')
  const own = (await $.env.get('MODEL_ROUTER_API_KEY'))?.trim()
  if (own) offer(slotOf(own), own, 'MODEL_ROUTER_API_KEY')
  offer('typesafe', await $.env.get('TYPESAFE_API_KEY'), 'TYPESAFE_API_KEY')
  offer('openai', await $.env.get('OPENAI_API_KEY'), 'OPENAI_API_KEY')
  offer('anthropic', await $.env.get('ANTHROPIC_API_KEY'), 'ANTHROPIC_API_KEY')
  return found
}

/** The key an explicitly chosen provider spends, for the providers that take no saved key. */
async function resolveOtherKey($: EngineInterface, settings: Settings): Promise<FoundKey | undefined> {
  if (settings.apiKey !== '') return { key: settings.apiKey, source: 'config' }
  const own = (await $.env.get('MODEL_ROUTER_API_KEY'))?.trim()
  if (own) return { key: own, source: 'MODEL_ROUTER_API_KEY' }
  if (settings.provider === 'jev' && isOpenRouter(settings)) {
    const key = (await $.env.get('OPENROUTER_API_KEY'))?.trim()
    if (key) return { key, source: 'OPENROUTER_API_KEY' }
  }
  return undefined
}

/**
 * The classifier a prompt asks. Under `auto`: Jev with a TypeSafe key, else
 * OpenAI Decisions with an OpenAI key, else Haiku on your own Anthropic key
 * when you saved or pasted one, else Haiku on the person's Claude plan.
 */
async function resolveClassifier($: EngineInterface, settings: Settings): Promise<Classifier> {
  if (settings.provider !== 'auto') {
    const slot = slotForProvider(settings)
    const found = slot === undefined ? await resolveOtherKey($, settings) : (await availableKeys($, settings))[slot]
    return { settings, key: found?.key, source: found?.source, problem: setupProblem(settings, found !== undefined) }
  }
  const keys = await availableKeys($, settings)
  for (const slot of KEY_SLOTS) {
    const found = keys[slot]
    // An ANTHROPIC_API_KEY in the environment is usually Claude Code's own; the plan serves that case.
    if (found === undefined || (slot === 'anthropic' && found.source === 'ANTHROPIC_API_KEY')) continue
    return { settings: withProvider(settings, SLOT_PROVIDER[slot]), key: found.key, source: found.source }
  }
  return { settings: withProvider(settings, 'claude-plan') }
}

/** `$.http.fetch` raced against the classifier's timeout. */
async function fetchWithin($: EngineInterface, request: ClassifierRequest, ms: number): Promise<HttpResponse | 'timeout'> {
  const stop = new AbortController()
  const timer = $.clock.sleep(ms, { signal: stop.signal }).then(
    () => 'timeout' as const,
    () => 'timeout' as const,
  )
  try {
    return await Promise.race([$.http.fetch(request.url, request.init), timer])
  } finally {
    stop.abort()
  }
}

/** Asks one classifier for a verdict; never throws. */
async function classify($: EngineInterface, settings: Settings, key: string | undefined, input: ClassifyInput): Promise<ClassifyOutcome> {
  try {
    if (settings.provider === 'claude-plan' || settings.provider === 'auto') {
      return readPlanReply(settings, await $.model.complete(planRequest(settings, input)))
    }
    if (key === undefined) return { error: 'no API key' }
    let request = classifierRequest(settings, key, input)
    let response = await fetchWithin($, request, settings.timeoutMs)
    // Some OpenAI-compatible servers refuse response_format; ask once more without it.
    if (response !== 'timeout' && response.status === 400 && settings.provider === 'openai-compatible') {
      request = classifierRequest(settings, key, input, false)
      response = await fetchWithin($, request, settings.timeoutMs)
    }
    return response === 'timeout' ? { error: timeoutProblem(settings) } : readHttpReply(request, response)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { error: `the classifier could not be reached: ${message.slice(0, 120)}` }
  }
}

/**
 * Decides the model and effort for `text`: what is fixed stands, the
 * classifier picks the rest, and when a keyed classifier fails, Haiku on the
 * person's plan steps in, so every prompt is routed.
 */
async function decide(
  $: EngineInterface,
  settings: Settings,
  text: string,
  fixed: InlineChoice,
  source: RouterRoute['source'],
): Promise<Decision> {
  const tiers = availableTiers(settings)
  if (tiers.length === 0) return { error: 'every model tier is empty in /config' }
  const fixedTier = fixed.tier === undefined ? undefined : nearestTier(fixed.tier, tiers)
  if (fixedTier !== undefined && fixed.effort !== undefined) {
    const effort = capEffort(fixed.effort, settings.maxEffort)
    const reason = source === 'pin' ? 'pinned with /router pin' : 'you asked for it'
    const classifier = source === 'pin' ? '/router pin' : 'you'
    return { route: { tier: fixedTier, model: settings.models[fixedTier], effort, reason, source, classifier } }
  }

  const [recent, current, contextTokens] = await Promise.all([
    $.session.messages().catch(() => []),
    read($, route),
    $.session.usage().then(
      usage => usage.context.tokens,
      () => undefined,
    ),
  ])
  const input: ClassifyInput = {
    prompt: text,
    recent: Array.isArray(recent) ? recent : [],
    current: current === null ? undefined : { tier: current.tier, effort: current.effort },
    contextTokens,
    tiers,
    maxEffort: settings.maxEffort,
  }

  const primary = await resolveClassifier($, settings)
  let used = primary.settings
  let outcome: ClassifyOutcome =
    primary.problem === undefined ? await classify($, primary.settings, primary.key, input) : { error: primary.problem }
  let stepIn = ''
  if ('error' in outcome && primary.settings.provider !== 'claude-plan') {
    const plan = withProvider(settings, 'claude-plan')
    const second = await classify($, plan, undefined, input)
    if ('verdict' in second) {
      stepIn = ` (Haiku stepped in: ${classifierLabel(primary.settings)} ${outcome.error.replace(/^no API key for [^.]+\. /, 'has no key. ')})`
      outcome = second
      used = plan
    } else {
      outcome = { error: `${classifierLabel(primary.settings)}: ${outcome.error}; Haiku: ${second.error}` }
    }
  }
  if ('error' in outcome) return outcome

  const settled = settle(outcome.verdict, settings)
  if (settled === undefined) return { error: 'no model tier is available' }
  const tier = fixedTier ?? settled.tier
  const effort = fixed.effort === undefined ? settled.effort : capEffort(fixed.effort, settings.maxEffort)
  const isFixed = fixedTier !== undefined || fixed.effort !== undefined
  const note = fixedTier === undefined && settled.note !== undefined ? ` (${settled.note})` : ''
  return {
    route: {
      tier,
      model: settings.models[tier],
      effort,
      reason: `${outcome.verdict.reason || 'no reason given'}${note}${stepIn}`,
      source: isFixed ? source : 'classifier',
      classifier: classifierLabel(used),
    },
  }
}

/** The effort the app's picker was last moved to by this module, so it is moved only on a change. */
let syncedEffort: string | undefined

/** Picker moves only a slash command can make, held for the turn's end: a command cannot run inside the prompt's own hook. */
let pendingCommands: { command: string; args: string }[] = []

/**
 * Moves the app's own model and effort picker to the route, as the person
 * would: the built-in /config rows when the session has them, else /model and
 * /effort. Only on a change, and never fatally: the per-request override in
 * `turn.step` holds the route either way.
 */
async function syncPicker($: EngineInterface, settings: Settings, chosen: RouterRoute): Promise<void> {
  if (!settings.syncPicker) return
  try {
    const rows = (await $.config.list()).filter(row => row.provider.plugin === 'engine')
    if (!isSameModel(await $.session.model(), chosen.model)) {
      const row = rows.find(one => one.key === 'model' || /^model$/i.test(one.label))
      const value = row && pickerOption(row.options, chosen.model, chosen.tier)
      const set = row && value !== undefined ? await $.config.set({ key: row.key, value }) : undefined
      if (set === undefined || set.deny !== undefined) pendingCommands.push({ command: 'model', args: chosen.model })
    }
    if (syncedEffort !== chosen.effort) {
      const row = rows.find(one => /effort/i.test(one.key) || /effort/i.test(one.label))
      const value = row && pickerOption(row.options, chosen.effort)
      const set = row && value !== undefined ? await $.config.set({ key: row.key, value }) : undefined
      if (set === undefined || set.deny !== undefined) pendingCommands.push({ command: 'effort', args: chosen.effort })
      syncedEffort = chosen.effort
    }
  } catch {
    // The picker stays where it was; every request still goes to the route.
  }
}

/** Records a decision: the route, the status line, and the card drawn under the prompt. */
async function apply($: EngineInterface, settings: Settings, decision: Decision, text: string): Promise<void> {
  const seq = await $.clock.now()
  let card: RouterCard
  if ('route' in decision) {
    const chosen = decision.route
    await update($, route, () => chosen)
    await update($, lastError, () => null)
    $.ui.status(statusLine(chosen, false))
    await syncPicker($, settings, chosen)
    card = { seq, key: cardKey(text), route: chosen }
  } else {
    await update($, lastError, () => decision.error)
    const kept = await read($, route)
    $.ui.status(statusLine(kept, false))
    card = { seq, key: cardKey(text), route: kept ?? undefined, kept: decision.error }
  }
  await update($, cards, list => [...list, card].slice(-CARD_LIMIT))
  pendingSeq = seq
}

/** What `/router` alone answers: the state, the setup, and the commands. */
async function statusReport($: EngineInterface, settings: Settings): Promise<string> {
  const [chosen, pinned, paused, error, classifier] = await Promise.all([
    read($, route),
    read($, pin),
    read($, isPaused),
    read($, lastError),
    resolveClassifier($, settings),
  ])
  const used = classifier.settings
  const key = used.provider === 'claude-plan' ? 'no key, uses your Claude plan' : classifier.source ? KEY_SOURCES[classifier.source] : 'no key yet'
  const how = settings.provider === 'auto' ? 'auto: Jev with TYPESAFE_API_KEY, else OpenAI Decisions with OPENAI_API_KEY, else Haiku on your plan' : settings.provider
  const lines = [
    paused ? 'Routing is paused. /router on resumes it.' : 'Every prompt is routed to the model and effort it needs.',
    `Classifier: ${classifierLabel(used)} · ${classifierModel(used) || '(model not set)'} · ${key}`,
    `Provider setting: ${how}`,
  ]
  if (used.provider !== 'claude-plan') lines.push('If it fails, Haiku on your Claude plan decides instead.')
  if (classifier.problem !== undefined) lines.push(`Setup needed: ${classifier.problem}`)
  lines.push(
    chosen === null
      ? "Last pick: none yet, so Claude Code's default model is in use."
      : `Last pick: ${routeLabel(chosen)} effort (${chosen.model}), by ${chosen.classifier} · ${chosen.reason}`,
  )
  if (error !== null) lines.push(`Last problem: ${error}`)
  const keys = await availableKeys($, settings)
  lines.push(
    `Keys: ${KEY_SLOTS.map(slot => {
      const found = keys[slot]
      return `${SLOTS[slot].name} ${found === undefined ? 'not set' : found.source === 'saved' ? `saved ••••${found.key.slice(-4)}` : `from ${found.source}`}`
    }).join(' · ')} (/router keys)`,
  )
  lines.push(
    pinned === null
      ? 'Pinned: nothing, the classifier decides.'
      : `Pinned: ${[pinned.tier, pinned.effort].filter(Boolean).join(' ')} (/router unpin to undo)`,
  )
  lines.push(`Models: ${TIERS.map(tier => `${tier} → ${settings.models[tier] || 'off'}`).join(' · ')}`)
  lines.push(`Highest effort: ${settings.maxEffort}`, '', HELP)
  return lines.join('\n')
}

/** How each key slot presents in the pane. */
const SLOTS: Record<RouterKeySlot, { name: string; product: string; note: string; placeholder: string }> = {
  typesafe: {
    name: 'TypeSafe AI',
    product: 'Jev',
    note: 'A decision model with calibrated odds: the most precise picks.',
    placeholder: 'Paste your TypeSafe key, then Enter',
  },
  openai: {
    name: 'OpenAI',
    product: 'Decisions API',
    note: 'gpt-6-luna answering typed choices; the API is in public beta.',
    placeholder: 'Paste your OpenAI key (sk-…), then Enter',
  },
  anthropic: {
    name: 'Anthropic',
    product: 'Haiku on your own key',
    note: 'Optional: Haiku on your Claude plan already works with no key.',
    placeholder: 'Paste your Anthropic key (sk-ant-…), then Enter',
  },
}

const PROVIDER_LABELS: Record<Settings['provider'], string> = {
  auto: 'Auto: the best key you have',
  'claude-plan': 'Haiku on your Claude plan (no key)',
  jev: 'Jev (TypeSafe AI)',
  'openai-decisions': 'OpenAI Decisions',
  anthropic: 'Haiku on your Anthropic key',
  openai: 'OpenAI chat (gpt-5-mini)',
  'openai-compatible': 'OpenAI-compatible (URL in /config)',
}

/** What a key check asks: an everyday prompt every classifier should call cheap. */
const SAMPLE_PROMPT = 'rename the variable userId to accountId in utils.ts'

async function setCheck($: EngineInterface, slot: RouterKeySlot, check: RouterKeyCheck | undefined): Promise<void> {
  await update($, keyChecks, checks => {
    const next = { ...checks }
    if (check === undefined) delete next[slot]
    else next[slot] = check
    return next
  })
}

/** Asks the slot's classifier one small question with the key it would spend, and says how that went. */
async function checkKey($: EngineInterface, settings: Settings, slot: RouterKeySlot): Promise<void> {
  const found = (await availableKeys($, settings))[slot]
  if (found === undefined) {
    await setCheck($, slot, { state: 'failed', text: 'no key to check' })
    return
  }
  await setCheck($, slot, { state: 'checking', text: 'checking…' })
  const started = await $.clock.now()
  const outcome = await classify($, withProvider(settings, SLOT_PROVIDER[slot]), found.key, {
    prompt: SAMPLE_PROMPT,
    recent: [],
    tiers: availableTiers(settings),
    maxEffort: settings.maxEffort,
  })
  const ms = Math.max(0, Math.round((await $.clock.now()) - started))
  await setCheck(
    $,
    slot,
    'verdict' in outcome
      ? { state: 'ok', text: `works · ${ms} ms · a quick rename got ${outcome.verdict.tier}, ${outcome.verdict.effort} effort` }
      : { state: 'failed', text: outcome.error },
  )
}

/** Saves a pasted key in this plugin's own store, clears the field, and checks the key at once. */
async function saveKey($: EngineInterface, settings: Settings, slot: RouterKeySlot, text: string): Promise<void> {
  const key = text.trim()
  const problem = keyProblem(key)
  await update($, keyVersion, version => version + 1)
  if (problem !== undefined) {
    await setCheck($, slot, { state: 'failed', text: `not saved: ${problem}` })
    return
  }
  const saved = await readSavedKeys($)
  await $.store.set(KEYS_STORE, { ...saved, [slot]: key })
  await checkKey($, settings, slot)
}

async function removeKey($: EngineInterface, slot: RouterKeySlot): Promise<void> {
  const saved = await readSavedKeys($)
  delete saved[slot]
  await $.store.set(KEYS_STORE, saved)
  await setCheck($, slot, undefined)
  await update($, keyVersion, version => version + 1)
}

/** Chooses the classifier from the pane: this plugin's `/config` row, changed as the person would. */
async function chooseProvider($: EngineInterface, value: string): Promise<void> {
  const row = (await $.config.list()).find(one => one.key.endsWith('.provider') && one.provider.plugin === $.plugin.name)
  if (row !== undefined) await $.config.set({ key: row.key, value })
}

/** Pauses or resumes routing, from the command or the band's button. */
async function setPaused($: EngineInterface, paused: boolean): Promise<void> {
  await update($, isPaused, () => paused)
  $.ui.status(statusLine(paused ? null : await read($, route), paused))
}

async function openKeys($: EngineInterface): Promise<boolean> {
  const { isPlaced } = await $.ui.open({ id: KEYS_PANE, title: '✻ Model router', focus: true, closeOnEscape: true })
  return isPlaced
}

/** Answers `/router <args>`. */
async function runCommand($: EngineInterface, settings: Settings, args: string): Promise<string> {
  const [verb = '', ...words] = args.trim().split(/\s+/).filter(Boolean)
  const tiers = availableTiers(settings)

  switch (verb.toLowerCase()) {
    case '':
    case 'status':
      return statusReport($, settings)

    case 'help':
      return HELP

    case 'keys':
    case 'key':
    case 'setup': {
      return (await openKeys($))
        ? '✻ Keys pane open: paste a key and press Enter to save and check it.'
        : '✻ The keys pane opens as soon as there is room for it.'
    }

    case 'off':
    case 'pause':
      await setPaused($, true)
      return "Routing is paused. Claude Code's own model setting applies until /router on."

    case 'on':
    case 'resume':
      await setPaused($, false)
      return 'Routing is on. Every prompt gets the model and effort it needs.'

    case 'pin': {
      const choice = parseChoice(words)
      if (choice === undefined) return `Pin what? Try /router pin opus, /router pin high or /router pin sonnet low.\n\n${HELP}`
      if (choice.tier !== undefined && !tiers.includes(choice.tier)) {
        return `${choice.tier} is turned off in /config (its model is empty). Available: ${tiers.join(', ')}.`
      }
      const pinned: RouterPin = choice
      await update($, pin, () => pinned)
      const what = [choice.tier, choice.effort && `${choice.effort} effort`].filter(Boolean).join(' at ')
      const rest = choice.tier !== undefined && choice.effort !== undefined ? '' : ' The classifier picks the rest.'
      return `Pinned ${what} from your next prompt on.${rest} /router unpin undoes it.`
    }

    case 'unpin':
    case 'auto':
      await update($, pin, () => null)
      return 'Unpinned: the classifier picks the model and effort again.'

    case 'test': {
      const prompt = words.join(' ')
      if (prompt === '') return 'Give a prompt to try: /router test fix the flaky login test'
      const decision = await decide($, settings, prompt, {}, 'classifier')
      if ('error' in decision) return `Could not classify it: ${decision.error}`
      const chosen = decision.route
      return `✻ ${routeLabel(chosen)} effort (${chosen.model}), by ${chosen.classifier} · ${chosen.reason}\nNothing was sent to Claude.`
    }

    default:
      return `Unknown option "${verb}".\n\n${HELP}`
  }
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'router',
      description: 'See or steer how each prompt picks its model and effort',
      argumentHint: '[test <prompt> | pin <model> [effort] | unpin | on | off]',
    })
    $.ui.status(statusLine(await read($, route), await read($, isPaused)))

    return next(e)
  })

  // Every prompt goes through the router: typed, delivered mid-turn, from a task or another session.
  on('prompt.submit', async ($, e, next) => {
    const text = promptText(e)
    if (text === '' || (await read($, isPaused))) return next(e)

    const inline = parseInline(e.text)
    const pinned = await read($, pin)
    const fixed: InlineChoice = { ...pinned, ...inline?.choice }
    const asked = inline?.rest ?? text
    await apply($, settings, await decide($, settings, asked, fixed, inline === undefined ? 'pin' : 'inline'), asked)

    return next(inline === undefined ? e : { ...e, text: asked })
  })

  // The prompt's row is stored: its card learns the row's id, so a repeated "yes" finds its own card.
  on('session.append', async ($, e, next) => {
    const seq = pendingSeq
    const isPrompt = e.door === 'prompt' || e.door === 'delivery'
    if (seq !== undefined && isPrompt && e.agentId === undefined && e.message.type === 'user' && e.message.isMeta !== true) {
      pendingSeq = undefined
      await update($, cards, list => list.map(card => (card.seq === seq ? { ...card, id: e.uuid } : card)))
    }
    return next(e)
  })

  // The picker moves that need /model or /effort, once the turn that held them is over.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && pendingCommands.length > 0) {
      const commands = pendingCommands
      pendingCommands = []
      for (const command of commands) await $.command.run(command).catch(() => undefined)
    }
    return result
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const chosen = await read($, route)
    if (chosen === null || (await read($, isPaused))) return yield* next(e)

    return yield* next({ ...e, model: chosen.model, effort: chosen.effort })
  })

  // The card under each prompt: Claude's spark, the model, the effort meter and why.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (!settings.announce) return next(e)
    const list = await read($, cards)
    const card = findCard(list, e.requestId, cardKey(e.props.text))
    if (card === undefined) return next(e)

    const base = await next(e)
    const view = cardView(card)

    if (e.surface === 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      const accent = view.tone === 'amber' ? 'warning' : 'claude'
      const meter = view.effort === undefined ? undefined : effortGlyphs(view.effort)
      return (
        <Box flexDirection="column">
          {base}
          <Box marginLeft={2} borderStyle="round" borderColor={accent} paddingX={1} alignSelf="flex-start">
            <Text color={accent} bold>
              ✻{' '}
            </Text>
            <Text bold>{view.title}</Text>
            {meter && <Text color={accent}>{`  ${meter.lit}`}</Text>}
            {meter && <Text dimColor>{meter.rest}</Text>}
            {view.effort && <Text>{` ${view.effort}`}</Text>}
            {view.tag && <Text color={accent}>{` · ${view.tag}`}</Text>}
            <Text dimColor wrap="truncate-end">{` · ${view.detail}`}</Text>
          </Box>
        </Box>
      )
    }

    const { Box, Svg } = $.ui.resolve(e)
    const art = cardSvg(view, list.at(-1)?.seq === card.seq, String(card.seq))
    return (
      <Box flexDirection="column">
        {base}
        <Box key={`route-${card.seq}`}>
          <Svg source={art.source} alt={art.alt} width={art.width} height={art.height} isInteractive />
        </Box>
      </Box>
    )
  })

  // Always above the prompt (terminal and desktop): the pick in force, and the controls.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [chosen, paused, pinned, classifier] = await Promise.all([read($, route), read($, isPaused), read($, pin), resolveClassifier($, settings)])
    const view = bandView({ route: chosen, isPaused: paused, pin: pinned, classifier: classifierLabel(classifier.settings), isWorking: e.props.isWorking })
    const { Box, Text, Button } = $.ui.resolve(e)
    const controls = [
      <Button key="router-toggle" label={paused ? 'Resume' : 'Pause'} variant={paused ? 'primary' : undefined} onPress={() => void setPaused($, !paused)} />,
      <Button key="router-keys" label="Keys" onPress={() => void openKeys($)} />,
      pinned !== null ? <Button key="router-unpin" label="Unpin" onPress={() => void update($, pin, () => null)} /> : null,
    ]

    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      const art = cardSvg(view, false, 'band')
      return (
        <Box key="router-band" flexDirection="row" alignItems="center" gap={1}>
          <Svg source={art.source} alt={art.alt} width={art.width} height={art.height} isInteractive />
          {controls}
        </Box>
      )
    }

    const accent = view.tone === 'amber' ? 'warning' : 'claude'
    const meter = view.effort === undefined ? undefined : effortGlyphs(view.effort)
    return (
      <Box key="router-band" flexDirection="row" alignItems="center" gap={1}>
        <Box borderStyle="round" borderColor={accent} paddingX={1} flexShrink={1}>
          <Text color={accent} bold>
            ✻{' '}
          </Text>
          <Text bold>{view.title}</Text>
          {meter && <Text color={accent}>{`  ${meter.lit}`}</Text>}
          {meter && <Text dimColor>{meter.rest}</Text>}
          {view.effort && <Text>{` ${view.effort}`}</Text>}
          {view.tag && <Text color={accent}>{` · ${view.tag}`}</Text>}
          <Text dimColor wrap="truncate-end">{` · ${view.detail}`}</Text>
        </Box>
        {controls}
      </Box>
    )
  })

  // The keys pane: one row per provider to paste, check or remove a key, and the classifier to use.
  on('ui.render', { component: 'Pane', requestId: KEYS_PANE }, async ($, e) => {
    const [checks, version, keys, classifier] = await Promise.all([
      read($, keyChecks),
      read($, keyVersion),
      availableKeys($, settings),
      resolveClassifier($, settings),
    ])
    const active = classifier.settings
    const how = classifier.source !== undefined ? KEY_SOURCES[classifier.source] : active.provider === 'claude-plan' ? 'no key, uses your Claude plan' : 'no key yet'
    const now = `${classifierLabel(active)} · ${classifierModel(active) || 'model not set'} · ${how}`
    const footer =
      'Keys saved here stay on this computer, in a file in your Claude Code config folder: plain text, never in your project. ' +
      'The field shows what you paste until you press Enter. A key saved here wins over environment variables. ' +
      'With no key at all, Haiku on your Claude plan still routes every prompt.'

    if (e.surface === 'mobile') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text color="claude" bold>
            ✻ Model router
          </Text>
          <Text>{`Classifier: ${now}`}</Text>
          <Text dimColor>Open /router keys on your computer to paste a key.</Text>
        </Box>
      )
    }

    const { Box, Text, Button, Input, Select } = $.ui.resolve(e)
    let header = (
      <Text color="claude" bold>
        ✻ Model router · keys and classifier
      </Text>
    )
    if (e.surface !== 'terminal') {
      const { Svg } = $.ui.resolve(e)
      const art = headerSvg('Model router', 'Keys and classifier')
      header = <Svg source={art.source} alt={art.alt} width={art.width} height={art.height} />
    }

    const slotRow = (slot: RouterKeySlot) => {
      const meta = SLOTS[slot]
      const found = keys[slot]
      // Only the last four characters are ever drawn.
      const hint = found?.source === 'saved' ? found.key.slice(-4) : undefined
      const check = checks[slot]
      const inUse = active.provider === SLOT_PROVIDER[slot] && classifier.source !== undefined
      const where = hint !== undefined ? `● saved here · ••••${hint}` : found !== undefined ? `● from ${found.source}` : '○ not set'
      const mark = check === undefined ? '' : check.state === 'ok' ? '✓' : check.state === 'failed' ? '✗' : '…'
      return (
        <Box key={`slot-${slot}`} flexDirection="column" marginTop={1}>
          <Box>
            <Text bold>{meta.name}</Text>
            <Text dimColor>{` · ${meta.product}`}</Text>
            {inUse && <Text color="claude">{'  ✻ in use'}</Text>}
          </Box>
          <Text dimColor>{meta.note}</Text>
          <Box>
            <Text color={found !== undefined ? 'claude' : undefined} dimColor={found === undefined}>
              {where}
            </Text>
            {check && (
              <Text color={check.state === 'ok' ? 'success' : check.state === 'failed' ? 'error' : undefined} dimColor={check.state === 'checking'}>
                {`  ${mark} ${check.text}`}
              </Text>
            )}
          </Box>
          <Input
            key={`${slot}-key-${version}`}
            placeholder={meta.placeholder}
            submitLabel="save"
            onSubmit={value => void saveKey($, settings, slot, value)}
          />
          {(found !== undefined || hint !== undefined) && (
            <Box gap={1}>
              {found !== undefined && <Button key={`${slot}-check`} label="Check" onPress={() => void checkKey($, settings, slot)} />}
              {hint !== undefined && <Button key={`${slot}-remove`} label="Remove" onPress={() => void removeKey($, slot)} />}
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        {KEY_SLOTS.map(slotRow)}
        <Box key="classifier" flexDirection="column" marginTop={1}>
          <Text bold>Classifier</Text>
          <Select
            key="provider"
            label="Use"
            value={settings.provider}
            options={PROVIDERS.map(value => ({ value, label: PROVIDER_LABELS[value] }))}
            onSelect={value => void chooseProvider($, value)}
          />
          <Text dimColor>{`Now: ${now}`}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>{footer}</Text>
        </Box>
        <Box marginTop={1}>
          <Button key="done" variant="primary" role="dismiss" label="Done" onPress={() => void $.ui.close({ id: KEYS_PANE })} />
        </Box>
      </Box>
    )
  })

  // A model picked with /model while routing runs would be overridden on the next prompt; say so.
  on('command.run', { command: 'model' }, async ($, e, next) => {
    const result = await next(e)
    if (e.origin.kind !== 'plugin' && !(await read($, isPaused)) && e.args.trim() !== '') {
      $.ui.toast('✻ Each prompt picks its own model. To keep one, use /router pin <model>, or /router off.', { timeoutMs: 8000 })
    }
    return result
  })

  on('command.run', { command: 'router' }, async ($, e) => ({ text: await runCommand($, settings, e.args) }))
}
