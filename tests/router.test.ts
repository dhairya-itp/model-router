import type { ConfigRow, HttpResponse, ModelCompleteResult, On, TurnStepInput } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { cardSvg, cardView, effortGlyphs } from '../hooks/card'
import { nearestTier, parseInline, parseVerdict, pickCovering, readSettings, settle } from '../hooks/classify'


const KEY = { provider: 'anthropic', apiKey: 'sk-test' }

/** What the engine stamps on a prompt or command the person typed. */
const TYPED = { origin: { kind: 'composer' as const }, wait: false }
const TYPED_COMMAND = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } }

/** The session's own step: Fable at max, so a rewrite shows. */
const STEP: TurnStepInput = { turnId: 't1', index: 0, model: 'claude-fable-5-1', effort: 'max', messageCount: 1 }

const SONNET = { reason: 'routine single-file fix', tier: 'sonnet', effort: 'medium', confidence: 'high' }
const OPUS = { reason: 'cross-cutting change', tier: 'opus', effort: 'high', confidence: 'high' }

function jsonReply(body: unknown, status = 200): HttpResponse {
  return { status, ok: status >= 200 && status < 300, headers: {}, text: JSON.stringify(body) }
}

function claudeReply(verdict: Record<string, string>): HttpResponse {
  return jsonReply({ content: [{ type: 'text', text: JSON.stringify(verdict) }], stop_reason: 'end_turn' })
}

function gptReply(verdict: Record<string, string>): HttpResponse {
  return jsonReply({ choices: [{ message: { role: 'assistant', content: JSON.stringify(verdict) } }] })
}

const USAGE = { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/**
 * Everything beneath the plugin: a classifier over HTTP answering `seen.reply`,
 * Haiku on the plan answering `seen.plan`, and a record of what got through.
 */
function world(on: On, reply: HttpResponse, env: Record<string, string> = {}, store: Record<string, unknown> = {}) {
  const seen = {
    reply,
    plan: { isAnswered: true, text: JSON.stringify(SONNET), usage: USAGE } as ModelCompleteResult,
    requests: [] as { url: string; headers: Record<string, string>; body: string }[],
    planCalls: [] as { model: string; system?: string }[],
    prompts: [] as string[],
    contexts: [] as (readonly string[] | undefined)[],
    steps: [] as TurnStepInput[],
    toasts: [] as string[],
    status: [] as (string | undefined)[],
    sessionModel: 'claude-fable-5-1',
    rows: [] as ConfigRow[],
    configSets: [] as { key: string; value: unknown }[],
    commands: [] as string[],
  }
  mock.clock(on, { now: 1000 })
  mock.env(on, env)
  mock.store(on, store)
  on('http.fetch', ($, e) => {
    seen.requests.push({ url: e.url, headers: e.init?.headers ?? {}, body: e.init?.body ?? '' })
    return { value: seen.reply }
  })
  on('model.complete', ($, e) => {
    seen.planCalls.push({ model: e.model, system: e.system })
    return { value: seen.plan }
  })
  on('session.messages', () => ({ value: [] }))
  on('session.model', () => ({ value: seen.sessionModel }))
  on('config.list', () => ({ value: seen.rows }))
  on('config.set', ($, e) => {
    seen.configSets.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  on('command.run', ($, e) => {
    seen.commands.push(`/${e.command} ${e.args}`)
    return { text: '' }
  })
  on('session.usage', () => ({ deny: 'no usage in tests' }))
  on('ui.status', ($, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    seen.prompts.push(e.text)
    seen.contexts.push(e.context)
    return { text: e.text }
  })
  on('turn.complete', ($, e) => ({ text: '' }))
  // Stands for the engine's own drawing of a row the plugin wraps.
  on('ui.render', () => ({ type: 'engine' as const, ref: 0 }))
  on('turn.step', async function* ($, e) {
    seen.steps.push(e)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return seen
}

/** What `/router` says, which names the last pick, who decided and why. */
async function routerStatus($: Engine): Promise<string> {
  return (await $.command.run({ command: 'router', args: '', ...TYPED_COMMAND })).text ?? ''
}

/** Runs one model request through the chain and returns what reached the bottom. */
async function step(run: AsyncIterable<unknown>, seen: { steps: TurnStepInput[] }): Promise<TurnStepInput | undefined> {
  for await (const _chunk of run) {
    // drain
  }
  return seen.steps.at(-1)
}

describe('every prompt is routed', () => {
  test('sends the turn to the model and effort the classifier picks', { options: KEY }, async ($, on) => {
    const seen = world(on, claudeReply(SONNET))
    await $.prompt.submit({ text: 'the login test fails with a TypeError, fix it', ...TYPED })
    const sent = await step($.turn.step(STEP), seen)

    expect(sent?.model).toBe('claude-sonnet-5-5')
    expect(sent?.effort).toBe('medium')
    expect(seen.requests[0]?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(seen.requests[0]?.headers['x-api-key']).toBe('sk-test')
    expect(seen.status.at(-1)).toBe('✻ Sonnet 5.5 · medium')
    expect(await routerStatus($)).toContain('by Haiku · API key · routine single-file fix')
    expect(seen.contexts.at(-1)?.join('\n')).toContain('this turn runs on Claude Sonnet 5.5 (model ID claude-sonnet-5-5)')
  })

  test('a prompt typed while a turn runs is routed too', { options: KEY }, async ($, on) => {
    const seen = world(on, claudeReply(OPUS))
    await $.prompt.submit({ text: 'actually, redesign the whole cache layer', ...TYPED, turnId: 'running' })
    const sent = await step($.turn.step({ ...STEP, index: 3 }), seen)

    expect(sent?.model).toBe('claude-opus-5-5')
  })

  test('a background task notification is routed too', { options: KEY }, async ($, on) => {
    const seen = world(on, claudeReply(SONNET))
    await $.prompt.submit({ text: 'Task finished: tests passed', origin: { kind: 'task-notification' }, wait: false })

    expect(seen.requests).toHaveLength(1)
  })

  test('rounds up one model when the classifier is unsure', { options: KEY }, async ($, on) => {
    const seen = world(on, claudeReply({ reason: 'maybe trivial', tier: 'haiku', effort: 'low', confidence: 'low' }))
    await $.prompt.submit({ text: 'tidy up the config loader', ...TYPED })
    const sent = await step($.turn.step(STEP), seen)

    expect(sent?.model).toBe('claude-sonnet-5-5')
    expect(sent?.effort).toBe('low')
  })

  test('an inline [model effort] skips the classifier and is removed from the prompt', { options: KEY }, async ($, on) => {
    const seen = world(on, claudeReply(SONNET))
    await $.prompt.submit({ text: '[opus high] design the billing data model', ...TYPED })
    const sent = await step($.turn.step(STEP), seen)

    expect(seen.requests).toHaveLength(0)
    expect(seen.prompts).toEqual(['design the billing data model'])
    expect(sent?.model).toBe('claude-opus-5-5')
    expect(sent?.effort).toBe('high')
    expect(seen.status.at(-1)).toBe('✻ Opus 5.5 · high · your pick')
  })

  test('a pinned effort stands while the classifier still picks the model', { options: KEY }, async ($, on) => {
    const seen = world(on, claudeReply({ reason: 'cross-cutting change', tier: 'opus', effort: 'xhigh', confidence: 'high' }))
    const pinned = await $.command.run({ command: 'router', args: 'pin low', ...TYPED_COMMAND })
    await $.prompt.submit({ text: 'migrate the store to zustand', ...TYPED })
    const sent = await step($.turn.step(STEP), seen)

    expect(pinned.text).toContain('Pinned low effort')
    expect(sent?.model).toBe('claude-opus-5-5')
    expect(sent?.effort).toBe('low')
  })

  test('leaves subagents on their own model', { options: KEY }, async ($, on) => {
    const seen = world(on, claudeReply(SONNET))
    await $.prompt.submit({ text: 'fix the failing test', ...TYPED })
    const sent = await step($.turn.step({ ...STEP, agentId: 'agent-1' }), seen)

    expect(sent?.model).toBe('claude-fable-5-1')
    expect(sent?.effort).toBe('max')
  })

  test('an effort above the cap is held to it', { options: { ...KEY, maxEffort: 'high' } }, async ($, on) => {
    const seen = world(on, claudeReply({ reason: 'hard concurrency bug', tier: 'opus', effort: 'max', confidence: 'high' }))
    await $.prompt.submit({ text: 'messages drop under load, sometimes', ...TYPED })
    const sent = await step($.turn.step(STEP), seen)

    expect(sent?.effort).toBe('high')
  })

  test('/router off stops routing until /router on', { options: KEY }, async ($, on) => {
    const seen = world(on, claudeReply(SONNET))
    await $.command.run({ command: 'router', args: 'off', ...TYPED_COMMAND })
    await $.prompt.submit({ text: 'fix the failing test', ...TYPED })
    const sent = await step($.turn.step(STEP), seen)

    expect(seen.requests).toHaveLength(0)
    expect(sent?.model).toBe('claude-fable-5-1')
  })

  test('/router test classifies without routing', { options: KEY }, async ($, on) => {
    const seen = world(on, claudeReply(SONNET))
    const answer = await $.command.run({ command: 'router', args: 'test fix the failing test', ...TYPED_COMMAND })
    const sent = await step($.turn.step(STEP), seen)

    expect(answer.text).toContain('Sonnet 5.5 · medium')
    expect(sent?.model).toBe('claude-fable-5-1')
  })
})

describe('auto picks the classifier from your keys', () => {
  test('with no key, Haiku on your Claude plan decides, with no HTTP', async ($, on) => {
    const seen = world(on, claudeReply(OPUS))
    await $.prompt.submit({ text: 'fix the failing test', ...TYPED })
    const sent = await step($.turn.step(STEP), seen)

    expect(seen.requests).toHaveLength(0)
    expect(seen.planCalls[0]?.model).toBe('haiku')
    expect(seen.planCalls[0]?.system).toContain('model router')
    expect(sent?.model).toBe('claude-sonnet-5-5')
    expect(seen.toasts).toHaveLength(0)
  })

  test('TYPESAFE_API_KEY sends it to Jev at TypeSafe, not OpenRouter', async ($, on) => {
    const seen = world(
      on,
      jsonReply({
        model: 'jev-1.13.0',
        answers: {
          tier: { type: 'choice', choice: 'opus', probabilities: { haiku: 0.02, sonnet: 0.08, opus: 0.9 }, confidence: 0.9 },
          effort: { type: 'choice', choice: 'xhigh', probabilities: { high: 0.2, xhigh: 0.8 }, confidence: 0.8 },
        },
        usage: { input_tokens: 700, output_tokens: 10 },
      }),
      { TYPESAFE_API_KEY: 'ts-key', OPENAI_API_KEY: 'sk-oa' },
    )
    await $.prompt.submit({ text: 'our websocket server drops messages under load, sometimes', ...TYPED })
    const sent = await step($.turn.step(STEP), seen)
    const body = JSON.parse(seen.requests[0]?.body ?? '{}')

    expect(seen.requests[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(seen.requests[0]?.headers.authorization).toBe('Bearer ts-key')
    expect(body.model).toBe('jev-latest')
    expect(Object.keys(body.questions.tier.criteria)).toEqual(['haiku', 'sonnet', 'opus'])
    expect(Object.keys(body.questions.effort.criteria)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(sent?.model).toBe('claude-opus-5-5')
    expect(sent?.effort).toBe('xhigh')
  })

  test('OPENAI_API_KEY alone sends it to the OpenAI Decisions API', async ($, on) => {
    const seen = world(
      on,
      jsonReply({
        answers: [
          {
            type: 'choice',
            name: 'tier',
            choice: 'opus',
            probabilities: [
              { value: 'haiku', probability: 0.01 },
              { value: 'sonnet', probability: 0.09 },
              { value: 'opus', probability: 0.9 },
            ],
            confidence: 0.88,
          },
          {
            type: 'choice',
            name: 'effort',
            choice: 'high',
            probabilities: [
              { value: 'medium', probability: 0.1 },
              { value: 'high', probability: 0.85 },
              { value: 'xhigh', probability: 0.05 },
            ],
            confidence: 0.8,
          },
        ],
      }),
      { OPENAI_API_KEY: 'sk-oa' },
    )
    await $.prompt.submit({ text: 'design the data model for multi-tenant billing', ...TYPED })
    const sent = await step($.turn.step(STEP), seen)
    const body = JSON.parse(seen.requests[0]?.body ?? '{}')

    expect(seen.requests[0]?.url).toBe('https://api.openai.com/v1/decisions')
    expect(seen.requests[0]?.headers.authorization).toBe('Bearer sk-oa')
    expect(body.model).toBe('gpt-6-luna')
    expect(body.questions.map((question: { name: string }) => question.name)).toEqual(['tier', 'effort'])
    expect(body.questions[0].choices[0]).toEqual({ value: 'haiku', description: expect.any(String) })
    expect(sent?.model).toBe('claude-opus-5-5')
    expect(sent?.effort).toBe('high')
  })

  test('a pasted OpenAI key goes to Decisions by its prefix', { options: { apiKey: 'sk-proj-abc' } }, async ($, on) => {
    const seen = world(on, jsonReply({ answers: [] }))
    await $.prompt.submit({ text: 'fix it', ...TYPED })

    expect(seen.requests[0]?.url).toBe('https://api.openai.com/v1/decisions')
  })
})

describe('when a classifier fails, Haiku steps in', () => {
  test('a rejected key falls back to Haiku on your plan', { options: KEY }, async ($, on) => {
    const seen = world(on, jsonReply({ error: { message: 'invalid x-api-key' } }, 401))
    seen.plan = { isAnswered: true, text: JSON.stringify(OPUS), usage: USAGE }
    await $.prompt.submit({ text: 'migrate the app to the new router', ...TYPED })
    const sent = await step($.turn.step(STEP), seen)
    const status = await routerStatus($)

    expect(sent?.model).toBe('claude-opus-5-5')
    expect(status).toContain('by Haiku · your plan')
    expect(status).toContain('Haiku stepped in: Haiku · API key the API key was rejected')
  })

  test('a chosen provider with no key falls back to Haiku', { options: { provider: 'jev' } }, async ($, on) => {
    const seen = world(on, jsonReply({}))
    await $.prompt.submit({ text: 'fix the failing test', ...TYPED })
    const sent = await step($.turn.step(STEP), seen)

    expect(seen.requests).toHaveLength(0)
    expect(sent?.model).toBe('claude-sonnet-5-5')
  })

  test('a Decisions refusal falls back to Haiku', { options: { provider: 'openai-decisions', apiKey: 'sk-oa' } }, async ($, on) => {
    const seen = world(on, jsonReply({ answers: [{ type: 'refusal', name: 'tier' }, { type: 'refusal', name: 'effort' }] }))
    await $.prompt.submit({ text: 'something', ...TYPED })
    const sent = await step($.turn.step(STEP), seen)

    expect(sent?.model).toBe('claude-sonnet-5-5')
    expect(seen.planCalls).toHaveLength(1)
  })

  test('when Haiku fails too, the last pick stays and the card says why', { options: KEY }, async ($, on) => {
    const seen = world(on, claudeReply(SONNET))
    await $.prompt.submit({ text: 'fix the failing test', ...TYPED })
    seen.reply = jsonReply({ error: { message: 'overloaded' } }, 529)
    seen.plan = { isAnswered: false, reason: 'aborted', usage: USAGE }
    await $.prompt.submit({ text: 'now add a test for it', ...TYPED })
    const sent = await step($.turn.step(STEP), seen)
    const row = { text: 'now add a test for it', origin: { kind: 'composer' as const }, isExpanded: false }
    const ui = await $.ui.mount({ plugin: 'model-router', surface: 'terminal', component: 'UserMessage', props: row })

    expect(sent?.model).toBe('claude-sonnet-5-5')
    expect(await routerStatus($)).toContain('Last problem: Haiku · API key: the provider is overloaded (529)')
    expect(await ui.find({ type: 'Text', text: /Kept Sonnet 5\.5/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('other providers', () => {
  test('jev takes the cheapest tier that is very likely enough', { options: { provider: 'jev', apiKey: 'ts-key' } }, async ($, on) => {
    const seen = world(
      on,
      jsonReply({
        answers: {
          tier: { type: 'choice', choice: 'haiku', probabilities: { haiku: 0.55, sonnet: 0.3, opus: 0.15 }, confidence: 0.4 },
          effort: { type: 'choice', choice: 'low', probabilities: { low: 0.6, medium: 0.3, high: 0.08, xhigh: 0.02 }, confidence: 0.5 },
        },
      }),
    )
    await $.prompt.submit({ text: 'tidy up the config loader', ...TYPED })
    const sent = await step($.turn.step(STEP), seen)

    expect(seen.requests[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(sent?.model).toBe('claude-sonnet-5-5')
    expect(sent?.effort).toBe('medium')
    expect(await routerStatus($)).toContain('Jev: haiku 55%, low effort 60% (rounded up: the classifier was unsure)')
  })

  test('jev through OpenRouter only when the base URL says so', { options: { provider: 'jev', baseUrl: 'https://openrouter.ai/api/v1' } }, async ($, on) => {
    const seen = world(on, jsonReply({ answers: {} }), { OPENROUTER_API_KEY: 'or-key' })
    await $.prompt.submit({ text: 'fix it', ...TYPED })

    expect(seen.requests[0]?.url).toBe('https://openrouter.ai/api/v1/systemone')
    expect(JSON.parse(seen.requests[0]?.body ?? '{}').model).toBe('~typesafe/jev-latest')
  })

  test('openai sends a strict JSON schema to chat completions', { options: { provider: 'openai', apiKey: 'sk-oa' } }, async ($, on) => {
    const seen = world(on, gptReply(SONNET))
    await $.prompt.submit({ text: 'fix the failing test', ...TYPED })
    const body = JSON.parse(seen.requests[0]?.body ?? '{}')

    expect(seen.requests[0]?.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(body.response_format.type).toBe('json_schema')
  })

  test(
    'openai-compatible uses the base URL and model given',
    { options: { provider: 'openai-compatible', apiKey: 'k', baseUrl: 'https://example.test/v1/', classifierModel: 'some-model' } },
    async ($, on) => {
      const seen = world(on, gptReply(SONNET))
      await $.prompt.submit({ text: 'fix the failing test', ...TYPED })

      expect(seen.requests[0]?.url).toBe('https://example.test/v1/chat/completions')
      expect(JSON.parse(seen.requests[0]?.body ?? '{}').model).toBe('some-model')
    },
  )
})

describe('the card under each prompt', () => {
  const ROW = { text: 'fix the failing test', origin: { kind: 'composer' as const }, isExpanded: false }

  test('draws a glowing SVG card where SVG is drawn, and a rounded Claude box in the terminal', { options: KEY }, async ($, on) => {
    world(on, claudeReply(SONNET))
    await $.prompt.submit({ text: ROW.text, ...TYPED })

    for (const surface of ['vscode', 'desktop', 'mobile'] as const) {
      const ui = await $.ui.mount({ plugin: 'model-router', surface, component: 'UserMessage', props: ROW })
      const svg = await ui.find({ type: 'Svg' })
      expect(String(svg?.props.alt)).toContain('Sonnet 5.5 · medium effort')
      expect(String(svg?.props.source)).toContain('feGaussianBlur')
      await ui.unmount()
    }

    const terminal = await $.ui.mount({ plugin: 'model-router', surface: 'terminal', component: 'UserMessage', props: ROW })
    expect(await terminal.find({ type: 'Text', text: /Sonnet 5\.5/ })).toBeDefined()
    expect(await terminal.find({ type: 'Text', text: /routine single-file fix/ })).toBeDefined()
    await terminal.unmount()
  })

  test('a prompt that was never routed draws as the engine has it', { options: KEY }, async ($, on) => {
    world(on, claudeReply(SONNET))
    const ui = await $.ui.mount({ plugin: 'model-router', surface: 'vscode', component: 'UserMessage', props: ROW })

    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('the keys pane', () => {
  const PANE = {
    title: '✻ Model router',
    isFocused: true,
    bodyColumns: 90,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  }
  const JEV_OK = jsonReply({
    answers: {
      tier: { type: 'choice', choice: 'haiku', probabilities: { haiku: 0.95, sonnet: 0.05 }, confidence: 0.95 },
      effort: { type: 'choice', choice: 'low', probabilities: { low: 0.9, medium: 0.1 }, confidence: 0.9 },
    },
  })

  test('/router keys opens a focused pane', async ($, on) => {
    world(on, JEV_OK)
    const opened: { id: string; focus?: true }[] = []
    on('ui.open', ($, e) => {
      opened.push(e)
      return { value: { isPlaced: true as const } }
    })
    const answer = await $.command.run({ command: 'router', args: 'keys', ...TYPED_COMMAND })

    expect(opened[0]).toEqual(expect.objectContaining({ id: 'router-keys', focus: true, closeOnEscape: true }))
    expect(answer.text).toContain('Keys pane open')
  })

  for (const surface of ['terminal', 'vscode', 'desktop'] as const) {
    test(`on ${surface}, pasting a key saves it, shows only its last four characters, checks it, and routes with it`, async ($, on) => {
      const seen = world(on, JEV_OK)
      const ui = await $.ui.mount({ plugin: 'model-router', surface, component: 'Pane', requestId: 'router-keys', props: PANE })
      expect(await ui.find({ type: 'Text', text: /○ not set/ })).toBeDefined()

      await ui.input({ key: 'typesafe-key-0', text: 'ts-secret-key-1234' })

      expect(await ui.find({ type: 'Text', text: /saved here · ••••1234/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /✓ works/ })).toBeDefined()
      expect(await ui.find({ text: /ts-secret-key-1234/ })).toBeUndefined()
      expect(await ui.find({ type: 'Input', key: 'typesafe-key-1' })).toBeDefined()
      expect(seen.requests[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
      expect(seen.requests[0]?.headers.authorization).toBe('Bearer ts-secret-key-1234')
      await ui.unmount()

      await $.prompt.submit({ text: 'fix the failing test', ...TYPED })
      expect(seen.requests.at(-1)?.headers.authorization).toBe('Bearer ts-secret-key-1234')
      expect(await routerStatus($)).toContain('TypeSafe AI saved ••••1234')
    })
  }

  test('Remove forgets a saved key', async ($, on) => {
    world(on, JEV_OK, {}, { keys: { openai: 'sk-proj-saved-5678' } })
    const ui = await $.ui.mount({ plugin: 'model-router', surface: 'vscode', component: 'Pane', requestId: 'router-keys', props: PANE })
    await ui.press({ key: 'openai-check' })
    expect(await ui.find({ type: 'Text', text: /••••5678/ })).toBeDefined()

    await ui.press({ key: 'openai-remove' })

    expect(await ui.find({ type: 'Text', text: /••••5678/ })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'openai-remove' })).toBeUndefined()
    await ui.unmount()
  })

  test('something that is not a key is not saved', async ($, on) => {
    world(on, JEV_OK)
    const ui = await $.ui.mount({ plugin: 'model-router', surface: 'terminal', component: 'Pane', requestId: 'router-keys', props: PANE })
    await ui.input({ key: 'openai-key-0', text: 'oops' })

    expect(await ui.find({ type: 'Text', text: /✗ not saved: that is too short/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /● saved here/ })).toBeUndefined()
    await ui.unmount()
  })

  test('the classifier picker changes the /config row', async ($, on) => {
    const seen = world(on, JEV_OK)
    seen.rows = [
      {
        key: 'model-router.provider',
        label: 'Classifier provider',
        kind: 'choice',
        value: 'auto',
        options: ['auto', 'claude-plan'],
        provider: { plugin: 'model-router', tier: 'user' },
        isLocked: false,
      },
    ]
    const ui = await $.ui.mount({ plugin: 'model-router', surface: 'vscode', component: 'Pane', requestId: 'router-keys', props: PANE })
    await ui.select({ key: 'provider', value: 'claude-plan' })

    expect(seen.configSets).toEqual([{ key: 'model-router.provider', value: 'claude-plan' }])
    await ui.unmount()
  })

  test('on a phone the pane says where to paste keys', async ($, on) => {
    world(on, JEV_OK)
    const ui = await $.ui.mount({ plugin: 'model-router', surface: 'mobile', component: 'Pane', requestId: 'router-keys', props: PANE })

    expect(await ui.find({ type: 'Text', text: /on your computer/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('the panel above the prompt', () => {
  const BAND = {
    hasSurvey: false,
    isWorking: false,
    maxRows: 30,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  }

  for (const surface of ['desktop', 'terminal'] as const) {
    test(`on ${surface}, pages through model, effort and keys, and pins with a number`, { options: KEY }, async ($, on) => {
      const seen = world(on, claudeReply(SONNET))
      const ui = await $.ui.mount({ plugin: 'model-router', surface, component: 'AbovePrompt', props: BAND })
      await ui.press({ key: 'router-model' })

      expect(await ui.find({ type: 'Text', text: /1 of 3/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'opt-tier-opus' })).toBeDefined()
      await ui.press({ key: 'opt-tier-opus' })
      expect(await ui.find({ type: 'Text', text: /● Opus 5\.5/ })).toBeDefined()

      await ui.press({ key: 'router-next' })
      expect(await ui.find({ type: 'Text', text: /2 of 3/ })).toBeDefined()
      await ui.press({ key: 'opt-effort-high' })

      await $.prompt.submit({ text: 'fix the failing test', ...TYPED })
      const sent = await step($.turn.step(STEP), seen)
      expect(sent?.model).toBe('claude-opus-5-5')
      expect(sent?.effort).toBe('high')
      expect(seen.requests).toHaveLength(0)

      await ui.press({ key: 'router-next' })
      expect(await ui.find({ type: 'Text', text: /3 of 3/ })).toBeDefined()
      await ui.press({ key: 'router-close' })
      expect(await ui.find({ type: 'Button', key: 'router-model' })).toBeDefined()
      await ui.unmount()
    })
  }

  test('choosing Jev without a key opens a key field under it, and saving the key makes Jev the classifier', async ($, on) => {
    const seen = world(on, jsonReply({
      answers: {
        tier: { type: 'choice', choice: 'haiku', probabilities: { haiku: 0.95, sonnet: 0.05 }, confidence: 0.95 },
        effort: { type: 'choice', choice: 'low', probabilities: { low: 0.9, medium: 0.1 }, confidence: 0.9 },
      },
    }))
    seen.rows = [
      { key: 'model-router.provider', label: 'Classifier provider', kind: 'choice', value: 'auto', options: ['auto', 'jev'], provider: { plugin: 'model-router', tier: 'user' }, isLocked: false },
    ]
    const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    await ui.press({ key: 'router-keys' })
    await ui.press({ key: 'opt-jev' })
    await ui.input({ key: 'typesafe-band-key-0', text: 'ts-secret-key-9876' })

    expect(seen.requests[0]?.headers.authorization).toBe('Bearer ts-secret-key-9876')
    expect(seen.configSets).toEqual([{ key: 'model-router.provider', value: 'jev' }])
    expect(await ui.find({ text: /ts-secret-key-9876/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /••••9876/ })).toBeDefined()
    await ui.unmount()
  })

  test('a first session opens the welcome, and Start routing closes it for good', async ($, on) => {
    world(on, claudeReply(SONNET))
    on('command.register', () => ({ value: { command: 'router' } }))
    on('session.start', ($, e) => ({ cwd: e.cwd, startedAt: 0, context: { window: 1000000 } }))
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'model-router', surface: 'terminal', component: 'AbovePrompt', props: BAND })

    expect(await ui.find({ type: 'Text', text: /Smart model routing/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /How should each prompt be judged/ })).toBeDefined()
    await ui.press({ key: 'router-start' })
    expect(await ui.find({ type: 'Button', key: 'router-model' })).toBeDefined()
    await ui.unmount()

    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    const again = await $.ui.mount({ plugin: 'model-router', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await again.find({ type: 'Text', text: /Smart model routing/ })).toBeUndefined()
    await again.unmount()
  })
})

describe("the app's model picker follows the pick, and your saved default comes back", () => {
  const ROWS: ConfigRow[] = [
    { key: 'model', label: 'Model', kind: 'choice', value: 'opus', options: ['default', 'opus', 'claude-sonnet-5-5', 'claude-haiku-5-5'], provider: { plugin: 'engine', tier: 'core' }, isLocked: false },
    { key: 'effortLevel', label: 'Effort', kind: 'choice', value: 'high', options: ['low', 'medium', 'high', 'xhigh', 'max'], provider: { plugin: 'engine', tier: 'core' }, isLocked: false },
  ]
  const SAVED = { theme: 'dark', model: 'opus', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } }

  /** A user settings file on disk that the /config rows write into, as Claude Code's do. */
  function settingsFile(on: On, seen: ReturnType<typeof world>) {
    const file = { text: JSON.stringify(SAVED, null, 2), writes: 0 }
    on('settings.read', () => ({ value: JSON.parse(file.text) }))
    on('fs.read', ($, e) => ({ value: e.path === '/home/me/.claude/settings.json' ? file.text : '' }))
    on('fs.write', ($, e) => {
      file.text = e.text
      file.writes += 1
      return { value: undefined }
    })
    seen.rows = ROWS
    return file
  }

  test('moves the Model and Effort rows, then restores the saved default when the session ends', { options: KEY }, async ($, on) => {
    const seen = world(on, claudeReply(SONNET), { HOME: '/home/me' })
    const file = settingsFile(on, seen)
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))

    await $.prompt.submit({ text: 'fix the failing test', ...TYPED })
    expect(seen.configSets).toEqual([
      { key: 'model', value: 'claude-sonnet-5-5' },
      { key: 'effortLevel', value: 'medium' },
    ])
    // Claude Code's rows save the pick as the default; the plugin's job is to undo that at the end.
    file.text = JSON.stringify({ ...SAVED, model: 'claude-sonnet-5-5', modelSettings: { 'claude-sonnet-5-5': { effortLevel: 'medium' } } })

    await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1' } as never)

    expect(JSON.parse(file.text)).toEqual(SAVED)
    expect(seen.commands).toEqual([])
  })

  test('a session that crashed is cleaned up when the next one starts', { options: KEY }, async ($, on) => {
    const seen = world(on, claudeReply(SONNET), { HOME: '/home/me' }, { savedDefaults: { model: 'opus', modelSettings: null } })
    const file = settingsFile(on, seen)
    file.text = JSON.stringify({ theme: 'dark', model: 'claude-haiku-5-5', modelSettings: { x: 1 } })
    on('command.register', () => ({ value: { command: 'router' } }))
    on('session.start', ($, e) => ({ cwd: e.cwd, startedAt: 0, context: { window: 1000000 } }))

    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

    expect(JSON.parse(file.text)).toEqual({ theme: 'dark', model: 'opus' })
  })

  test('leaves a model already in place alone', { options: KEY }, async ($, on) => {
    const seen = world(on, claudeReply(SONNET), { HOME: '/home/me' })
    settingsFile(on, seen)
    seen.sessionModel = 'claude-sonnet-5-5[1m]'
    await $.prompt.submit({ text: 'fix the failing test', ...TYPED })

    expect(seen.configSets).toEqual([{ key: 'effortLevel', value: 'medium' }])
  })

  test('can be turned off', { options: { ...KEY, syncPicker: false } }, async ($, on) => {
    const seen = world(on, claudeReply(SONNET), { HOME: '/home/me' })
    const file = settingsFile(on, seen)
    await $.prompt.submit({ text: 'fix the failing test', ...TYPED })

    expect(seen.configSets).toEqual([])
    expect(file.writes).toBe(0)
  })
})

describe('the band above the prompt', () => {
  const BAND = {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  }

  for (const surface of ['desktop', 'terminal'] as const) {
    test(`on ${surface}, shows the pick in force and pauses, resumes and opens keys`, { options: KEY }, async ($, on) => {
      world(on, claudeReply(SONNET))
      const opened: string[] = []
      on('ui.open', ($, e) => {
        opened.push(e.id)
        return { value: { isPlaced: true as const } }
      })
      await $.prompt.submit({ text: 'fix the failing test', ...TYPED })
      const ui = await $.ui.mount({ plugin: 'model-router', surface, component: 'AbovePrompt', props: BAND })

      const shown = surface === 'desktop' ? String((await ui.find({ type: 'Svg' }))?.props.alt) : (await ui.find({ type: 'Text', text: /Sonnet 5\.5/ }))?.text
      expect(shown).toContain('Sonnet 5.5')

      await ui.press({ key: 'router-toggle' })
      const paused = surface === 'desktop' ? String((await ui.find({ type: 'Svg' }))?.props.alt) : (await ui.find({ type: 'Text', text: /Routing paused/ }))?.text
      expect(paused).toContain('Routing paused')
      expect((await ui.find({ type: 'Button', key: 'router-toggle' }))?.props.label).toBe('Resume')

      await ui.press({ key: 'router-toggle' })
      expect((await ui.find({ type: 'Button', key: 'router-toggle' }))?.props.label).toBe('Pause')

      await ui.press({ key: 'router-keys' })
      const keysPage = surface === 'desktop' ? String((await ui.find({ type: 'Svg' }))?.props.alt) : (await ui.find({ type: 'Text', text: /Who decides/ }))?.text
      expect(keysPage).toContain('Who decides')
      expect(opened).toEqual([])
      await ui.unmount()
    })
  }

  test('before the first prompt it says routing is on', async ($, on) => {
    world(on, claudeReply(SONNET))
    const ui = await $.ui.mount({ plugin: 'model-router', surface: 'terminal', component: 'AbovePrompt', props: BAND })

    expect(await ui.find({ type: 'Text', text: /Auto routing/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('helpers', () => {
  test('parseVerdict reads JSON inside prose or code fences', () => {
    const verdict = parseVerdict('Sure:\n```json\n{"reason":"x","tier":"Opus","effort":"XHigh","confidence":"low"}\n```')
    expect(verdict).toEqual({ tier: 'opus', effort: 'xhigh', confidence: 'low', reason: 'x' })
    expect(parseVerdict('no json here')).toBeUndefined()
    expect(parseVerdict('{"tier":"gpt","effort":"low"}')).toBeUndefined()
  })

  test('pickCovering takes the cheapest option that is very likely enough', () => {
    expect(pickCovering(['a', 'b', 'c'], { a: 0.85, b: 0.1, c: 0.05 }, 0.8)).toBe('a')
    expect(pickCovering(['a', 'b', 'c'], { a: 0.5, b: 0.35, c: 0.15 }, 0.8)).toBe('b')
    expect(pickCovering(['a', 'b', 'c'], { c: 1 }, 0.8)).toBe('c')
    expect(pickCovering(['a', 'b'], {}, 0.8)).toBeUndefined()
  })

  test('an unavailable tier moves to the nearest available one', () => {
    expect(nearestTier('fable', ['haiku', 'sonnet', 'opus'])).toBe('opus')
    expect(nearestTier('haiku', ['sonnet', 'opus'])).toBe('sonnet')
    const settings = readSettings({})
    expect(settle({ tier: 'opus', effort: 'max', confidence: 'low', reason: '' }, settings)).toEqual({ tier: 'opus', effort: 'xhigh', note: undefined })
  })

  test('parseInline takes only exact model and effort words', () => {
    expect(parseInline('[sonnet low] rename it')).toEqual({ choice: { tier: 'sonnet', effort: 'low' }, rest: 'rename it' })
    expect(parseInline('[high] why is this slow?')).toEqual({ choice: { effort: 'high' }, rest: 'why is this slow?' })
    expect(parseInline('[x] done item')).toBeUndefined()
    expect(parseInline('[opus]')).toBeUndefined()
  })

  test('the card escapes what it draws and lights one bar per effort step', () => {
    const view = cardView({
      seq: 1,
      key: 'k',
      route: { tier: 'opus', model: 'claude-opus-5-5', effort: 'high', reason: 'a <b> & "c"', source: 'pin', classifier: 'Jev' },
    })
    const art = cardSvg(view, true)
    expect(art.source).toContain('a &lt;b&gt; &amp; &quot;c&quot;')
    expect(art.source).toContain('<animate ')
    expect(view.tag).toBe('pinned')
    expect(effortGlyphs('high')).toEqual({ lit: '▁▂▄', rest: '▆█' })
  })
})
