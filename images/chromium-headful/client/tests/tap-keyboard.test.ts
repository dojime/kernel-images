import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { parseComponent } from 'vue-template-compiler'
import { focusNeedsGesture } from '../src/utils/text-input'

// Load the real component methods without mounting its media player or child components.
const script = parseComponent(readFileSync(new URL('../src/components/video.vue', import.meta.url), 'utf8')).script!
  .content
const compiled = ts.transpileModule(script, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true },
}).outputText

type Kind = 'text' | 'other'

// A 1920x1080 stream shown 390px wide, as on a phone in portrait.
function setup(mode: string, ios = true) {
  let clock = 0
  let timers: { fn: () => void; at: number; id: number }[] = []
  let nextTimer = 1
  let nextKind: Kind = 'other'
  const doc = { activeElement: null as unknown }
  const win = {
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, at: clock + ms, id: nextTimer })
      return nextTimer++
    },
    clearTimeout: (id: number) => {
      timers = timers.filter((t) => t.id !== id)
    },
  }

  const exports: { default?: { prototype: Record<string, Function> } } = {}
  const noDecorator = () => () => undefined
  runInNewContext(compiled, {
    exports,
    require: (name: string) => {
      if (name === 'vue-property-decorator') {
        return {
          Vue: class {},
          Component: () => (type: unknown) => type,
          Ref: noDecorator,
          Watch: noDecorator,
          Prop: noDecorator,
        }
      }
      if (name === '~/utils/cursor-shape') return { cachedCursorKind: () => nextKind }
      if (name === '~/utils/text-input') return { focusNeedsGesture }
      return {}
    },
    window: win,
    document: doc,
    performance: { now: () => clock },
  })

  const attributes = new Map<string, string>()
  const events: string[] = []
  const proto = exports.default!.prototype
  const ctx: Record<string, any> = Object.create(proto)
  // Vue binds component methods to the instance, so they can be passed as callbacks
  for (const key of Object.getOwnPropertyNames(proto)) {
    const value = Object.getOwnPropertyDescriptor(proto, key)!.value
    if (typeof value === 'function' && key !== 'constructor') ctx[key] = value.bind(ctx)
  }
  const overlay = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 219 }),
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
    focus: () => {
      if (doc.activeElement === overlay) return
      events.push(`focus${attributes.has('inputmode') ? ':' + attributes.get('inputmode') : ''}`)
      doc.activeElement = overlay
      ctx.onOverlayFocus()
    },
    blur: () => {
      if (doc.activeElement !== overlay) return
      events.push('blur')
      doc.activeElement = null
      ctx.onOverlayBlur()
    },
  }
  // own data properties, so they shadow the component's getters
  const state = {
    tapKeyboard: mode,
    focusNeedsGesture: ios,
    hosting: false,
    _overlay: overlay,
    _player: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 664 }) },
    $accessor: { video: { resolution: { w: 1920, h: 1080 } } },
    keyboardOpen: false,
    focusHeld: false,
    typeChip: null,
    cursorKind: 'other',
    cursorChangedAt: 0,
    cursorSeq: 0,
    pointer: null,
    textSpot: null,
    pointerJumpAt: 0,
    previousPointerJumpAt: 0,
    touchBeganAt: 0,
    pendingTap: null,
    pendingTapTimer: 0,
    lateTap: null,
    resetInputSentinel: () => {},
    resetKeyboard: () => {},
    unmuteOnInteraction: () => {},
    $emit: () => {},
    controlling: true,
    locked: false,
    $client: { sendData: () => {} },
  }
  for (const [key, value] of Object.entries(state)) {
    Object.defineProperty(ctx, key, { value, writable: true })
  }

  const advance = (ms: number) => {
    const until = clock + ms
    for (;;) {
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      timers = timers.filter((t) => t !== due)
      clock = due.at
      due.fn()
    }
    clock = until
  }

  // touchstart moves the pointer to p; the finger lifts after 80ms
  const tap = (p: { x: number; y: number }) => {
    ctx.touchBeganAt = clock
    ctx.sendPointer(p)
    advance(80)
    ctx.keyboardAfterTap(p)
  }

  const cursor = (kind: Kind) => {
    nextKind = kind
    ctx.onCursorImage({})
  }
  const keyboardUp = () => ctx.keyboardOpen && doc.activeElement === overlay && !attributes.has('inputmode')

  return { ctx, tap, cursor, advance, events, attributes, keyboardUp, doc, overlay }
}

const field = { x: 100, y: 50 }
const blank = { x: 200, y: 180 }

describe('tap keyboard on iOS', () => {
  test('a text cursor after the finger lifts raises the keyboard through the focus taken in the tap', () => {
    const t = setup('auto')
    t.tap(field)
    expect(t.events).toEqual(['focus:none'])
    expect(t.ctx.keyboardOpen).toBe(false)

    t.advance(150)
    t.cursor('text')
    expect(t.keyboardUp()).toBe(true)
    expect(t.events).toEqual(['focus:none'])
    expect(t.ctx.typeChip).toBe(null)
  })

  test('a text cursor flashed after another cursor still counts', () => {
    const t = setup('auto')
    t.tap(field)
    t.advance(100)
    t.cursor('other')
    t.advance(300)
    t.cursor('text')
    expect(t.keyboardUp()).toBe(true)
  })

  test('a non-text tap releases the held focus without a keyboard', () => {
    const t = setup('auto')
    t.tap(blank)
    t.advance(100)
    t.cursor('other')
    t.advance(800)
    expect(t.events).toEqual(['focus:none', 'blur'])
    expect(t.ctx.keyboardOpen).toBe(false)
    expect(t.attributes.has('inputmode')).toBe(false)
    expect(t.ctx.typeChip).toBe(null)
  })

  test('a text cursor after the window offers the chip', () => {
    const t = setup('auto')
    t.tap(field)
    t.advance(900)
    t.cursor('text')
    expect(t.ctx.keyboardOpen).toBe(false)
    expect(t.ctx.typeChip).not.toBe(null)
  })

  test('tapping a field under an unchanged text cursor raises the keyboard', () => {
    const t = setup('auto')
    t.advance(2000)
    t.tap(field)
    t.advance(150)
    t.cursor('text')
    t.overlay.blur()
    // 30 CSS px from the remembered spot, inside the same wide field
    t.advance(2000)
    t.tap({ x: field.x + 30, y: field.y })
    expect(t.ctx.keyboardOpen).toBe(false)
    t.advance(800)
    expect(t.keyboardUp()).toBe(true)
    expect(t.ctx.typeChip).toBe(null)
  })

  test('a tap near where a text cursor was seen raises the keyboard inside the tap', () => {
    const t = setup('auto')
    t.advance(2000)
    t.tap(field)
    t.advance(150)
    t.cursor('text')
    t.overlay.blur()
    t.events.length = 0

    // 8 CSS px is about 40 remote px on this stream
    t.advance(2000)
    t.tap({ x: field.x + 8, y: field.y })
    expect(t.events).toEqual(['focus'])
    expect(t.keyboardUp()).toBe(true)
  })

  test('a tap near a remembered spot that turns out not to be text closes the keyboard', () => {
    const t = setup('auto')
    t.advance(2000)
    t.tap(field)
    t.advance(150)
    t.cursor('text')
    t.overlay.blur()

    t.advance(2000)
    t.tap({ x: field.x, y: field.y + 8 })
    expect(t.keyboardUp()).toBe(true)
    t.advance(100)
    t.cursor('other')
    t.advance(800)
    expect(t.ctx.keyboardOpen).toBe(false)
    expect(t.ctx.textSpot).toBe(null)
  })

  test('a scroll started before the cursor arrives drops the tap', () => {
    const t = setup('auto')
    t.tap(field)
    t.advance(50)
    t.ctx.onGestureBegin(blank)
    expect(t.events).toEqual(['focus:none', 'blur'])
    t.advance(100)
    t.cursor('text')
    t.advance(2000)
    expect(t.ctx.keyboardOpen).toBe(false)
    expect(t.doc.activeElement).toBe(null)
    expect(t.ctx.typeChip).toBe(null)
  })

  test('falls back to the chip when the focus could not be held', () => {
    const t = setup('auto')
    t.overlay.focus = () => {}
    t.tap(field)
    t.advance(150)
    t.cursor('text')
    expect(t.ctx.keyboardOpen).toBe(false)
    expect(t.attributes.has('inputmode')).toBe(false)
    expect(t.ctx.typeChip).not.toBe(null)
  })
})

describe('tap keyboard elsewhere', () => {
  test('focuses after the tap without holding focus during it', () => {
    const t = setup('auto', false)
    t.tap(field)
    expect(t.events).toEqual([])
    t.advance(150)
    t.cursor('text')
    expect(t.events).toEqual(['focus'])
    expect(t.keyboardUp()).toBe(true)
  })

  test('chip mode offers the chip and never focuses', () => {
    const t = setup('chip')
    t.tap(field)
    t.advance(150)
    t.cursor('text')
    expect(t.events).toEqual([])
    expect(t.ctx.typeChip).not.toBe(null)
  })

  test('chip mode shows nothing for a text cursor after the window', () => {
    const t = setup('chip')
    t.tap(field)
    t.advance(900)
    t.cursor('text')
    expect(t.ctx.typeChip).toBe(null)
  })

  test('off mode does nothing and always mode focuses inside the tap', () => {
    const off = setup('off')
    off.tap(field)
    off.advance(150)
    off.cursor('text')
    expect(off.events).toEqual([])
    expect(off.ctx.typeChip).toBe(null)

    const always = setup('always')
    always.tap(blank)
    expect(always.events).toEqual(['focus'])
  })
})

describe('focusNeedsGesture', () => {
  test('detects iOS and iPadOS', () => {
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15'
    expect(focusNeedsGesture({ userAgent: iphone, platform: 'iPhone', maxTouchPoints: 5 })).toBe(true)
    expect(focusNeedsGesture({ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true)
    expect(focusNeedsGesture({ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false)
    expect(focusNeedsGesture({ userAgent: 'Linux; Android 14', platform: 'Linux armv8l', maxTouchPoints: 5 })).toBe(
      false,
    )
  })
})
