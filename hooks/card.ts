import type { RouterCard, RouterEffort, RouterPin, RouterRoute } from '../types'
import { EFFORTS, modelLabel } from './classify'

/** Claude's accent and its warm highlight; amber when the router could only keep a pick. */
const TONES = {
  claude: { from: '#D97757', to: '#F2A27E' },
  amber: { from: '#D4A053', to: '#F0C987' },
} as const

export type CardTone = keyof typeof TONES

/** What a card says, whatever draws it. */
export type CardView = {
  tone: CardTone
  title: string
  effort?: RouterEffort
  tag?: string
  detail: string
  tooltip: string
}

const DETAIL_CHARS = 90

function shorten(text: string, chars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= chars ? flat : `${flat.slice(0, chars - 1).trimEnd()}…`
}

/** The view of a card: the route it got, or what was kept and why. */
export function cardView(card: RouterCard): CardView {
  const route = card.route
  if (card.kept !== undefined) {
    return {
      tone: 'amber',
      title: route ? `Kept ${modelLabel(route.model)}` : 'Default model',
      effort: route?.effort,
      detail: shorten(card.kept, DETAIL_CHARS),
      tooltip: `Nothing could decide for this prompt: ${card.kept}`,
    }
  }
  if (route === undefined) return { tone: 'amber', title: 'Default model', detail: 'not routed', tooltip: 'not routed' }
  const tag = route.source === 'pin' ? 'pinned' : route.source === 'inline' ? 'your pick' : undefined
  return {
    tone: 'claude',
    title: modelLabel(route.model),
    effort: route.effort,
    tag,
    detail: shorten(route.reason, DETAIL_CHARS),
    tooltip: `${modelLabel(route.model)} (${route.model}) at ${route.effort} effort. Decided by ${route.classifier}: ${route.reason}`,
  }
}

/** What the band above the prompt says: the pick in force, routing paused, or the pick to come. */
export function bandView(input: {
  route: RouterRoute | null
  isPaused: boolean
  pin: RouterPin | null
  classifier: string
  isWorking: boolean
}): CardView {
  const { route, isPaused, pin, classifier, isWorking } = input
  if (isPaused) {
    return {
      tone: 'amber',
      title: 'Routing paused',
      detail: "Claude Code's own model is in use · Resume to route every prompt again",
      tooltip: 'Routing is paused',
    }
  }
  if (route === null) {
    return {
      tone: 'claude',
      title: 'Auto routing',
      tag: pin ? 'pinned' : undefined,
      detail: `${classifier} picks the model and effort for your next prompt`,
      tooltip: `Every prompt is routed. Classifier: ${classifier}`,
    }
  }
  const tag = pin ? 'pinned' : route.source === 'inline' ? 'your pick' : isWorking ? 'working' : undefined
  return {
    tone: 'claude',
    title: modelLabel(route.model),
    effort: route.effort,
    tag,
    detail: shorten(`by ${route.classifier} · ${route.reason}`, DETAIL_CHARS),
    tooltip: `${modelLabel(route.model)} (${route.model}) at ${route.effort} effort. Decided by ${route.classifier}: ${route.reason}`,
  }
}

/** How many of the five effort steps are lit. */
export function effortSteps(effort: RouterEffort): number {
  return EFFORTS.indexOf(effort) + 1
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** A rough advance per character at these sizes, so the pill hugs its text. */
function textWidth(text: string, size: number, isBold = false): number {
  let units = 0
  for (const char of text) {
    if (/[ilj.,:;'|!·]/.test(char)) units += 0.3
    else if (/[mwMW@%]/.test(char)) units += 0.85
    else if (/[A-Z0-9]/.test(char)) units += 0.66
    else if (char === ' ') units += 0.3
    else units += 0.56
  }
  return units * size * (isBold ? 1.07 : 1)
}

/**
 * The card as one SVG: a pill with Claude's gradient edge over a soft blurred
 * halo, the Claude spark, the model, a five-step effort meter, a tag and the
 * reason. Light and dark follow the viewer's color scheme. The newest card's
 * halo breathes a few times and its spark turns once; older cards sit still.
 */
export function cardSvg(view: CardView, isNewest: boolean, id = 'c'): { source: string; width: number; height: number; alt: string } {
  const tone = TONES[view.tone]
  // Ids of this card alone, so cards drawn into one page never borrow each other's paint.
  const edge = `edge-${id}`
  const ray = `ray-${id}`
  const halo = `halo-${id}`
  const bloom = `bloom-${id}`
  const clip = `clip-${id}`
  const pad = 12
  const height = 30
  const cy = pad + height / 2
  let x = pad + 14

  const spark = { cx: x + 7, cy }
  x += 22
  const titleX = x
  x += textWidth(view.title, 12.5, true) + 12

  const bars: string[] = []
  let effortX = 0
  if (view.effort !== undefined) {
    const lit = effortSteps(view.effort)
    for (let step = 0; step < 5; step += 1) {
      const barHeight = 4 + step * 2.2
      const isLit = step < lit
      bars.push(
        `<rect x="${(x + step * 6).toFixed(1)}" y="${(cy + 6 - barHeight).toFixed(1)}" width="4" height="${barHeight.toFixed(1)}" rx="1.4" ${
          isLit ? `fill="url(#${edge})" filter="url(#${bloom})"` : 'class="off"'
        }/>`,
      )
    }
    x += 5 * 6 + 6
    effortX = x
    x += textWidth(view.effort, 11.5) + 10
  }

  let tagSvg = ''
  if (view.tag !== undefined) {
    const tagWidth = textWidth(view.tag, 10.5) + 14
    tagSvg =
      `<rect x="${x.toFixed(1)}" y="${(cy - 9).toFixed(1)}" width="${tagWidth.toFixed(1)}" height="18" rx="9" fill="${tone.from}" fill-opacity=".16" stroke="${tone.from}" stroke-opacity=".45"/>` +
      `<text x="${(x + 7).toFixed(1)}" y="${(cy + 3.6).toFixed(1)}" class="tag" fill="${tone.from}">${escape(view.tag)}</text>`
    x += tagWidth + 10
  }

  const detailX = x
  x += textWidth(`· ${view.detail}`, 11.5) + 16
  const pillWidth = Math.ceil(x - pad)
  const width = pillWidth + pad * 2
  const total = height + pad * 2

  const breathe = isNewest
    ? '<animate attributeName="opacity" values=".28;.62;.28" dur="2.6s" repeatCount="3"/>'
    : ''
  const twinkle = isNewest
    ? `<animateTransform attributeName="transform" type="rotate" from="0 ${spark.cx} ${spark.cy}" to="90 ${spark.cx} ${spark.cy}" dur="1.1s" fill="freeze" calcMode="spline" keySplines=".2 .8 .2 1" keyTimes="0;1"/>`
    : ''
  const rays = [0, 45, 90, 135]
    .map(angle => `<line x1="${spark.cx - 6.5}" y1="${spark.cy}" x2="${spark.cx + 6.5}" y2="${spark.cy}" transform="rotate(${angle} ${spark.cx} ${spark.cy})"/>`)
    .join('')

  const source = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${total}" viewBox="0 0 ${width} ${total}" role="img">`,
    `<title>${escape(view.tooltip)}</title>`,
    '<style>',
    'text{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif;font-style:normal}',
    '.pill{fill:#FFFBF7}.title{fill:#1F1E1D;font-weight:600;font-size:12.5px}',
    '.label{fill:#3D3A36;font-size:11.5px}.muted{fill:#7A756E;font-size:11.5px}',
    '.tag{font-size:10.5px;font-weight:600}.off{fill:#E3DCD4}',
    '@media (prefers-color-scheme: dark){',
    '.pill{fill:#262321}.title{fill:#F7F3EE}.label{fill:#E4DED6}.muted{fill:#A8A29A}.off{fill:#47423D}',
    '}',
    '</style>',
    '<defs>',
    `<linearGradient id="${edge}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${tone.from}"/><stop offset="1" stop-color="${tone.to}"/></linearGradient>`,
    // The spark's rays are straight lines with no height, so their paint is laid out in the card's own space.
    `<linearGradient id="${ray}" gradientUnits="userSpaceOnUse" x1="${spark.cx - 7}" y1="${spark.cy - 7}" x2="${spark.cx + 7}" y2="${spark.cy + 7}"><stop offset="0" stop-color="${tone.from}"/><stop offset="1" stop-color="${tone.to}"/></linearGradient>`,
    `<filter id="${halo}" x="-30%" y="-120%" width="160%" height="340%"><feGaussianBlur stdDeviation="6"/></filter>`,
    `<filter id="${bloom}" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur in="SourceGraphic" stdDeviation="1.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`,
    `<clipPath id="${clip}"><rect x="${pad}" y="${pad}" width="${pillWidth - 12}" height="${height}" rx="${height / 2}"/></clipPath>`,
    '</defs>',
    `<rect x="${pad}" y="${pad}" width="${pillWidth}" height="${height}" rx="${height / 2}" fill="url(#${edge})" filter="url(#${halo})" opacity=".4">${breathe}</rect>`,
    `<rect class="pill" x="${pad}" y="${pad}" width="${pillWidth}" height="${height}" rx="${height / 2}" stroke="url(#${edge})" stroke-width="1.3"/>`,
    `<g stroke="url(#${ray})" stroke-width="2.3" stroke-linecap="round" filter="url(#${bloom})">${twinkle}${rays}</g>`,
    `<text x="${titleX.toFixed(1)}" y="${(cy + 4.4).toFixed(1)}" class="title">${escape(view.title)}</text>`,
    bars.join(''),
    view.effort !== undefined ? `<text x="${effortX.toFixed(1)}" y="${(cy + 4).toFixed(1)}" class="label">${escape(view.effort)}</text>` : '',
    tagSvg,
    `<text x="${detailX.toFixed(1)}" y="${(cy + 4).toFixed(1)}" class="muted" clip-path="url(#${clip})">· ${escape(view.detail)}</text>`,
    '</svg>',
  ].join('')

  const alt = [view.title, view.effort && `${view.effort} effort`, view.tag, view.detail].filter(Boolean).join(' · ')
  return { source, width, height: total, alt }
}

/** The five-step meter as text for the terminal: the lit steps, then the rest. */
export function effortGlyphs(effort: RouterEffort): { lit: string; rest: string } {
  const glyphs = '▁▂▄▆█'
  const steps = effortSteps(effort)
  return { lit: glyphs.slice(0, steps), rest: glyphs.slice(steps) }
}

/** Folds whitespace so a prompt's row can find its card by text. */
export function cardKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 2000)
}

/** The keys pane's header: the Claude spark with a soft glow, a title and a quiet subtitle. */
export function headerSvg(title: string, subtitle: string): { source: string; width: number; height: number; alt: string } {
  const tone = TONES.claude
  const height = 56
  const spark = { cx: 28, cy: height / 2 }
  const titleX = 52
  const width = Math.ceil(titleX + Math.max(textWidth(title, 16, true), textWidth(subtitle, 12)) + 24)
  const rays = [0, 45, 90, 135]
    .map(angle => `<line x1="${spark.cx - 10}" y1="${spark.cy}" x2="${spark.cx + 10}" y2="${spark.cy}" transform="rotate(${angle} ${spark.cx} ${spark.cy})"/>`)
    .join('')
  const source = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`,
    '<style>',
    'text{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif}',
    '.h{fill:#1F1E1D;font-size:16px;font-weight:600}.s{fill:#7A756E;font-size:12px}',
    '@media (prefers-color-scheme: dark){.h{fill:#F7F3EE}.s{fill:#A8A29A}}',
    '</style>',
    '<defs>',
    `<linearGradient id="hdr-ray" gradientUnits="userSpaceOnUse" x1="${spark.cx - 10}" y1="${spark.cy - 10}" x2="${spark.cx + 10}" y2="${spark.cy + 10}"><stop offset="0" stop-color="${tone.from}"/><stop offset="1" stop-color="${tone.to}"/></linearGradient>`,
    '<filter id="hdr-glow" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="7"/></filter>',
    '<filter id="hdr-bloom" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur in="SourceGraphic" stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>',
    '</defs>',
    `<circle cx="${spark.cx}" cy="${spark.cy}" r="13" fill="${tone.from}" opacity=".45" filter="url(#hdr-glow)"/>`,
    `<g stroke="url(#hdr-ray)" stroke-width="3" stroke-linecap="round" filter="url(#hdr-bloom)">${rays}</g>`,
    `<text x="${titleX}" y="${spark.cy - 2}" class="h">${escape(title)}</text>`,
    `<text x="${titleX}" y="${spark.cy + 15}" class="s">${escape(subtitle)}</text>`,
    '</svg>',
  ].join('')
  return { source, width, height, alt: `${title}: ${subtitle}` }
}
