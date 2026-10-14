import { describe, expect, test } from 'bun:test'
import {
  charToKeysym,
  keysymNeedsShift,
  needsShift,
  textDiff,
  TextInput,
  XK_BACKSPACE,
  XK_RETURN,
  XK_SHIFT_L,
} from '../src/utils/text-input'
import { ZoomPan } from '../src/utils/zoom-pan'
import { GestureHandlers, Point, TouchGestures } from '../src/utils/touch-gestures'

describe('text input', () => {
  test('maps characters to keysyms', () => {
    expect(charToKeysym('a')).toBe(0x61)
    expect(charToKeysym('é')).toBe(0xe9)
    expect(charToKeysym('€')).toBe(0x010020ac)
    expect(charToKeysym('\n')).toBe(XK_RETURN)
  })

  test('detects letters that need shift', () => {
    expect(needsShift('A')).toBe(true)
    expect(needsShift('a')).toBe(false)
    expect(needsShift('!')).toBe(false)
    expect(keysymNeedsShift(0x41)).toBe(true)
    expect(keysymNeedsShift(0x61)).toBe(false)
    expect(keysymNeedsShift(0xc9)).toBe(true)
    expect(keysymNeedsShift(0x01000416)).toBe(true)
  })

  test('diffs composition updates', () => {
    expect(textDiff('', 'te')).toEqual({ deletes: 0, insert: 'te' })
    expect(textDiff('tez', 'tes')).toEqual({ deletes: 1, insert: 's' })
    expect(textDiff('hello', 'help')).toEqual({ deletes: 2, insert: 'p' })
  })
})

describe('soft keyboard text', () => {
  const A = 0x41
  const setup = (touch = true) => {
    const sent: string[] = []
    let shift = false
    const name = (key: number) =>
      key === XK_SHIFT_L
        ? 'Shift'
        : key === XK_BACKSPACE
        ? 'BS'
        : key === XK_RETURN
        ? 'Enter'
        : String.fromCharCode(key)
    const input = new TextInput(
      (event, key) => sent.push(`${event === 'keydown' ? '+' : '-'}${name(key)}`),
      () => shift,
      () => touch,
    )
    return { input, sent, holdShift: (held: boolean) => (shift = held) }
  }

  test('text from a key event is not typed again by its input event', () => {
    const { input, sent } = setup()
    input.keyDown(0x61)
    input.input('insertText', 'a')
    input.keyUp(0x61)
    // a keyboard that reports keyCode 229 sends only the input event
    input.input('insertText', 'b')
    expect(sent).toEqual(['+a', '-a', '+b', '-b'])
  })

  test('a key without text does not swallow the next input event', () => {
    const { input, sent } = setup()
    input.keyDown(0xff51)
    input.keyUp(0xff51)
    input.input('insertText', 'x')
    expect(sent.slice(-2)).toEqual(['+x', '-x'])
  })

  test('types line breaks and backspace from input events', () => {
    const { input, sent } = setup()
    input.input('insertLineBreak', null)
    input.input('deleteContentBackward', null)
    expect(sent).toEqual(['+Enter', '-Enter', '+BS', '-BS'])
  })

  test('types composition updates as edits and ignores the echo after compositionend', () => {
    const { input, sent } = setup()
    input.compositionStart()
    input.input('insertCompositionText', 'te')
    input.input('insertCompositionText', 'tez')
    input.input('insertCompositionText', 'te')
    input.compositionEnd('tea', true)
    input.input('insertText', 'tea')
    expect(sent.join(' ')).toBe('+t -t +e -e +z -z +BS -BS +a -a')
    expect(input.composing).toBe(false)

    // only the event right after compositionend is an echo
    input.input('insertText', 'tea')
    expect(sent.slice(-6).join(' ')).toBe('+t -t +e -e +a -a')
  })

  test('a key event ends the window for a composition echo', () => {
    const { input, sent } = setup()
    input.compositionStart()
    input.compositionEnd('a', true)
    input.keyEvent(false)
    input.input('insertText', 'a')
    expect(sent).toEqual(['+a', '-a', '+a', '-a'])
  })

  test('drops composed text while input is disabled', () => {
    const { input, sent } = setup()
    input.compositionStart()
    input.compositionEnd('hi', false)
    expect(sent).toEqual([])
  })

  test('sends Shift around capitals from a soft keyboard', () => {
    const { input, sent } = setup()
    input.keyDown(A)
    input.keyUp(A)
    input.input('insertText', 'B')
    expect(sent.join(' ')).toBe('+Shift +A -A -Shift +Shift +B -B -Shift')
  })

  test('does not send Shift under Caps Lock or a held Shift', () => {
    const { input, sent, holdShift } = setup()
    input.keyEvent(true)
    input.keyDown(A)
    input.keyUp(A)
    input.input('insertText', 'B')
    input.keyEvent(false)
    holdShift(true)
    input.keyDown(A)
    input.keyUp(A)
    expect(sent.join(' ')).toBe('+A -A +B -B +A -A')
  })

  test('never adds Shift for a desktop keyboard', () => {
    const { input, sent } = setup(false)
    input.keyDown(A, 0x1234)
    input.keyUp(A, 0x1234)
    expect(sent).toEqual([`+${String.fromCharCode(0x1234)}`, `-${String.fromCharCode(0x1234)}`])
  })
})

describe('zoom and pan', () => {
  const element = { left: 0, top: 200, width: 400, height: 225 }
  const viewport = { left: 0, top: 0, width: 400, height: 625 }

  test('keeps the content point under the fingers while scaling', () => {
    const zoom = new ZoomPan(
      () => element,
      () => viewport,
      () => 8,
    )
    zoom.pinchStart({ x: 200, y: 312 }, 100)
    zoom.pinchMove({ x: 200, y: 312 }, 300)
    expect(zoom.scale).toBe(3)
    // content point (200, 112) in element px stays at client (200, 312)
    expect(element.left + zoom.tx + 200 * zoom.scale).toBeCloseTo(200)
    expect(element.top + zoom.ty + 112 * zoom.scale).toBeCloseTo(312)
  })

  test('clamps scale and keeps the viewport covered', () => {
    const zoom = new ZoomPan(
      () => element,
      () => viewport,
      () => 4,
    )
    zoom.pinchStart({ x: 10, y: 210 }, 100)
    zoom.pinchMove({ x: 390, y: 600 }, 1000)
    expect(zoom.scale).toBe(4)
    expect(element.left + zoom.tx).toBeLessThanOrEqual(viewport.left)
    expect(element.left + zoom.tx + element.width * 4).toBeGreaterThanOrEqual(viewport.left + viewport.width)
    expect(element.top + zoom.ty).toBeLessThanOrEqual(viewport.top)
    expect(element.top + zoom.ty + element.height * 4).toBeGreaterThanOrEqual(viewport.top + viewport.height)
  })

  test('never zooms out below the fitted size', () => {
    const zoom = new ZoomPan(
      () => element,
      () => viewport,
      () => 4,
    )
    zoom.pinchStart({ x: 200, y: 312 }, 300)
    zoom.pinchMove({ x: 200, y: 312 }, 100)
    expect(zoom.scale).toBe(1)
    expect(zoom.transform).toBe('')
  })
})

describe('touch gestures', () => {
  const touches = (...points: Point[]) => points.map((p) => ({ clientX: p.x, clientY: p.y })) as unknown as TouchList
  const event = (timeStamp: number, ...points: Point[]) =>
    ({ timeStamp, touches: touches(...points) } as unknown as TouchEvent)

  const recorder = (overrides: Partial<GestureHandlers> = {}) => {
    const calls: string[] = []
    const handlers = new Proxy(overrides as GestureHandlers, {
      get: (target, name: string) =>
        name in target
          ? target[name as keyof GestureHandlers]
          : (...args: unknown[]) => calls.push(`${name} ${JSON.stringify(args)}`),
    })
    return { calls, handlers }
  }

  test('a short touch without movement is a tap', () => {
    const { calls, handlers } = recorder()
    const g = new TouchGestures(handlers)
    g.touchStart(event(0, { x: 10, y: 10 }))
    g.touchMove(event(20, { x: 12, y: 11 }))
    g.touchEnd(event(60))
    g.destroy()
    expect(calls.map((c) => c.split(' ')[0])).toEqual(['onTouchBegin', 'onTap'])
  })

  test('movement past the slop scrolls by the finger delta', () => {
    const { calls, handlers } = recorder()
    const g = new TouchGestures(handlers)
    g.touchStart(event(0, { x: 100, y: 300 }))
    g.touchMove(event(16, { x: 100, y: 280 }))
    g.touchMove(event(32, { x: 100, y: 250 }))
    g.touchEnd(event(200))
    g.destroy()
    const scrolls = calls.filter((c) => c.startsWith('onScroll'))
    expect(scrolls.length).toBe(2)
    expect(scrolls[0]).toContain('[0,-20,')
    expect(scrolls[1]).toContain('[0,-30,')
    expect(calls.some((c) => c.startsWith('onTap'))).toBe(false)
  })

  test('two fingers pinch and never scroll or tap', () => {
    const { calls, handlers } = recorder()
    const g = new TouchGestures(handlers)
    g.touchStart(event(0, { x: 100, y: 300 }))
    g.touchStart(event(10, { x: 100, y: 300 }, { x: 200, y: 300 }))
    g.touchMove(event(26, { x: 80, y: 300 }, { x: 220, y: 300 }))
    g.touchEnd(event(40, { x: 220, y: 300 }))
    g.touchMove(event(56, { x: 260, y: 300 }))
    g.touchEnd(event(70))
    g.destroy()
    const names = calls.map((c) => c.split(' ')[0])
    expect(names).toEqual(['onTouchBegin', 'onPinchStart', 'onPinchMove', 'onPinchEnd'])
  })

  // fake timers and animation frames, swapped into the globals the recognizer uses
  const fakeTime = () => {
    let now = 0
    let timers: { fn: () => void; at: number; id: number }[] = []
    let frames = new Map<number, (t: number) => void>()
    let nextId = 1
    const saved = {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      requestAnimationFrame: globalThis.requestAnimationFrame,
      cancelAnimationFrame: globalThis.cancelAnimationFrame,
      now: performance.now,
    }
    Object.assign(globalThis, {
      setTimeout: (fn: () => void, ms: number) => {
        timers.push({ fn, at: now + ms, id: nextId })
        return nextId++
      },
      clearTimeout: (id: number) => {
        timers = timers.filter((t) => t.id !== id)
      },
      requestAnimationFrame: (fn: (t: number) => void) => {
        frames.set(nextId, fn)
        return nextId++
      },
      cancelAnimationFrame: (id: number) => frames.delete(id),
    })
    performance.now = () => now
    return {
      advance(ms: number) {
        now += ms
        for (const t of timers.filter((t) => t.at <= now)) {
          timers = timers.filter((x) => x !== t)
          t.fn()
        }
      },
      // runs pending animation frames 16ms apart, up to a limit
      frames(limit: number) {
        let ran = 0
        while (frames.size > 0 && ran < limit) {
          now += 16
          const pending = frames
          frames = new Map()
          for (const fn of pending.values()) fn(now)
          ran++
        }
        return ran
      },
      get pendingFrames() {
        return frames.size
      },
      restore() {
        Object.assign(globalThis, saved)
        performance.now = saved.now
      },
    }
  }

  const fling = (g: TouchGestures) => {
    g.touchStart(event(0, { x: 100, y: 400 }))
    g.touchMove(event(16, { x: 100, y: 380 }))
    g.touchMove(event(32, { x: 100, y: 340 }))
    g.touchMove(event(48, { x: 100, y: 300 }))
    g.touchEnd(event(50))
  }

  test('a fast swipe flings until the velocity decays', () => {
    const time = fakeTime()
    try {
      const { calls, handlers } = recorder()
      const g = new TouchGestures(handlers)
      fling(g)
      expect(g.flinging).toBe(true)
      const before = calls.length
      expect(time.frames(1000)).toBeLessThan(1000)
      expect(calls.length).toBeGreaterThan(before + 10)
      expect(g.flinging).toBe(false)
    } finally {
      time.restore()
    }
  })

  test('stopping the fling from the scroll handler ends it', () => {
    const time = fakeTime()
    try {
      let scrolls = 0
      const { handlers } = recorder({
        onScroll: () => {
          scrolls++
          if (g.flinging) g.stopFling()
        },
      })
      const g = new TouchGestures(handlers)
      fling(g)
      const swipe = scrolls
      time.frames(100)
      expect(scrolls).toBe(swipe + 1)
      expect(time.pendingFrames).toBe(0)
      expect(g.flinging).toBe(false)
    } finally {
      time.restore()
    }
  })

  test('cancel stops a fling and ends a scroll without further handlers', () => {
    const time = fakeTime()
    try {
      const { calls, handlers } = recorder()
      const g = new TouchGestures(handlers)
      fling(g)
      time.frames(2)
      g.cancel()
      expect(g.flinging).toBe(false)
      expect(time.pendingFrames).toBe(0)

      calls.length = 0
      g.touchStart(event(1000, { x: 100, y: 400 }))
      g.touchMove(event(1016, { x: 100, y: 380 }))
      g.cancel()
      g.touchMove(event(1032, { x: 100, y: 300 }))
      g.touchEnd(event(1034))
      time.frames(100)
      expect(calls.map((c) => c.split(' ')[0])).toEqual(['onTouchBegin', 'onScroll'])
    } finally {
      time.restore()
    }
  })

  test('cancel releases a drag once and delivers nothing after it', () => {
    const time = fakeTime()
    try {
      const { calls, handlers } = recorder()
      const g = new TouchGestures(handlers)
      g.touchStart(event(0, { x: 50, y: 60 }))
      time.advance(500)
      g.touchMove(event(520, { x: 80, y: 60 }))
      g.cancel()
      g.touchMove(event(540, { x: 120, y: 60 }))
      g.touchEnd(event(600))
      expect(calls.map((c) => c.split(' ')[0])).toEqual([
        'onTouchBegin',
        'onLongPress',
        'onDragStart',
        'onDragMove',
        'onDragEnd',
      ])
      expect(calls[calls.length - 1]).toBe('onDragEnd [{"x":80,"y":60}]')
    } finally {
      time.restore()
    }
  })

  test('a cancelled touch can still pinch', () => {
    const { calls, handlers } = recorder()
    const g = new TouchGestures(handlers)
    g.touchStart(event(0, { x: 100, y: 300 }))
    g.cancel()
    g.touchStart(event(10, { x: 100, y: 300 }, { x: 200, y: 300 }))
    g.touchMove(event(26, { x: 80, y: 300 }, { x: 220, y: 300 }))
    g.touchEnd(event(40))
    expect(calls.map((c) => c.split(' ')[0])).toEqual(['onTouchBegin', 'onPinchStart', 'onPinchMove', 'onPinchEnd'])
  })

  test('a touch the page does not take only pinches', () => {
    const time = fakeTime()
    try {
      const { calls, handlers } = recorder({ onTouchBegin: () => false })
      const g = new TouchGestures(handlers)
      g.touchStart(event(0, { x: 100, y: 300 }))
      time.advance(600)
      g.touchMove(event(620, { x: 100, y: 200 }))
      g.touchEnd(event(640))
      g.touchStart(event(1000, { x: 100, y: 300 }))
      g.touchEnd(event(1050))
      expect(calls).toEqual([])

      g.touchStart(event(2000, { x: 100, y: 300 }))
      g.touchStart(event(2010, { x: 100, y: 300 }, { x: 200, y: 300 }))
      g.touchEnd(event(2040))
      expect(calls.map((c) => c.split(' ')[0])).toEqual(['onPinchStart', 'onPinchEnd'])
    } finally {
      time.restore()
    }
  })

  test('a long press released in place is a right click', () => {
    const time = fakeTime()
    try {
      const { calls, handlers } = recorder()
      const g = new TouchGestures(handlers)
      g.touchStart(event(0, { x: 50, y: 60 }))
      time.advance(500)
      g.touchMove(event(520, { x: 53, y: 62 }))
      g.touchEnd(event(600))
      expect(calls.map((c) => c.split(' ')[0])).toEqual(['onTouchBegin', 'onLongPress', 'onLongPressRelease'])
    } finally {
      time.restore()
    }
  })

  test('a long press then move drags', () => {
    const time = fakeTime()
    try {
      const { calls, handlers } = recorder()
      const g = new TouchGestures(handlers)
      g.touchStart(event(0, { x: 50, y: 60 }))
      time.advance(500)
      g.touchMove(event(520, { x: 80, y: 60 }))
      g.touchMove(event(540, { x: 120, y: 60 }))
      g.touchEnd(event(600))
      expect(calls).toEqual([
        'onTouchBegin [{"x":50,"y":60}]',
        'onLongPress [{"x":50,"y":60}]',
        'onDragStart [{"x":50,"y":60}]',
        'onDragMove [{"x":80,"y":60}]',
        'onDragMove [{"x":120,"y":60}]',
        'onDragEnd [{"x":120,"y":60}]',
      ])
    } finally {
      time.restore()
    }
  })

  test('touchcancel ends a drag or pinch and never taps', () => {
    const time = fakeTime()
    try {
      const { calls, handlers } = recorder()
      const g = new TouchGestures(handlers)
      g.touchStart(event(0, { x: 50, y: 60 }))
      g.touchCancel()
      time.advance(600)
      g.touchEnd(event(700))

      g.touchStart(event(1000, { x: 50, y: 60 }))
      time.advance(500)
      g.touchMove(event(1520, { x: 90, y: 60 }))
      g.touchCancel()

      g.touchStart(event(2000, { x: 100, y: 300 }))
      g.touchStart(event(2010, { x: 100, y: 300 }, { x: 200, y: 300 }))
      g.touchCancel()
      expect(calls.map((c) => c.split(' ')[0])).toEqual([
        'onTouchBegin',
        'onTouchBegin',
        'onLongPress',
        'onDragStart',
        'onDragMove',
        'onDragEnd',
        'onTouchBegin',
        'onPinchStart',
        'onPinchEnd',
      ])
    } finally {
      time.restore()
    }
  })
})
