// Helpers for turning text from mobile soft keyboards into X keysyms.
// Android keyboards report keyCode 229 for most keys, which the Guacamole
// keyboard ignores, so their text only arrives through input events.

export const XK_SHIFT_L = 0xffe1
export const XK_BACKSPACE = 0xff08
export const XK_RETURN = 0xff0d

export function charToKeysym(ch: string): number {
  if (ch === '\n' || ch === '\r') return XK_RETURN
  const cp = ch.codePointAt(0) as number
  // Latin-1 keysyms equal their code points; everything else uses the Unicode range
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp
  return 0x01000000 | cp
}

// Neko maps a keysym to a keycode using the current modifier state. An upper
// case letter sent without Shift lands on the lower case key, so soft keyboards
// that never report Shift type the wrong case.
export function needsShift(ch: string) {
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase()
}

export function keysymNeedsShift(keysym: number) {
  if (keysym >= 0x41 && keysym <= 0x5a) return true
  if (keysym >= 0xc0 && keysym <= 0xde && keysym !== 0xd7) return true
  if ((keysym & 0xff000000) === 0x01000000) return needsShift(String.fromCodePoint(keysym & 0x00ffffff))
  return false
}

// iOS (every browser there is WebKit) raises the soft keyboard only for focus()
// inside a user gesture handler. Other mobile browsers also raise it for a
// later focus() once the page has had a user gesture.
export function focusNeedsGesture(nav: { userAgent: string; platform: string; maxTouchPoints: number }) {
  return /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
}

// Minimal edit that turns prev into next: delete from the end, then insert.
export function textDiff(prev: string, next: string) {
  const a = Array.from(prev)
  const b = Array.from(next)
  let common = 0
  while (common < a.length && common < b.length && a[common] === b[common]) common++
  return { deletes: a.length - common, insert: b.slice(common).join('') }
}

type KeySink = (event: 'keydown' | 'keyup', keysym: number) => void

// The one path from keyboard input to X key events on touch devices: key events
// from the Guacamole keyboard, and text that arrives only as input or
// composition events. Shift is sent around keys that need it here, since soft
// keyboards never report Shift and Caps Lock already gives the upper case.
export class TextInput {
  // from the last native key event; soft keyboards report it as off
  capsLock = false
  composing = false
  private composed = ''
  // a key event already sent the text the next input event reports
  private keyed = false
  // compositionend already sent this text, and some keyboards repeat it in an input event
  private compositionEcho: string | null = null
  private shiftWrapped = new Set<number>()

  constructor(private send: KeySink, private shiftHeld: () => boolean, private touch: () => boolean) {}

  // sent: the keysym after layout mapping
  keyDown(keysym: number, sent = keysym) {
    if (this.needsShift(keysym)) {
      this.shiftWrapped.add(keysym)
      this.send('keydown', XK_SHIFT_L)
    }
    this.send('keydown', sent)
    this.keyed = true
  }

  keyUp(keysym: number, sent = keysym) {
    this.keyed = false
    this.send('keyup', sent)
    if (this.shiftWrapped.delete(keysym)) this.send('keyup', XK_SHIFT_L)
  }

  // any native keydown or keyup on the overlay
  keyEvent(capsLock: boolean) {
    this.capsLock = capsLock
    this.compositionEcho = null
  }

  input(inputType: string, data: string | null) {
    const keyed = this.keyed
    const echo = this.compositionEcho !== null && data === this.compositionEcho
    this.keyed = false
    this.compositionEcho = null

    if (inputType === 'insertCompositionText') {
      this.updateComposition(data || '')
      return
    }
    if (keyed || echo) return

    switch (inputType) {
      case 'insertText':
      case 'insertReplacementText':
        this.type(data || '')
        break
      case 'insertLineBreak':
      case 'insertParagraph':
        this.press(XK_RETURN)
        break
      case 'deleteContentBackward':
        this.press(XK_BACKSPACE)
        break
    }
  }

  compositionStart() {
    this.composing = true
    this.composed = ''
    this.compositionEcho = null
  }

  // send: false when input is not enabled, so the text is dropped
  compositionEnd(data: string, send: boolean) {
    if (send) this.updateComposition(data)
    this.compositionEcho = data
    this.composing = false
    this.composed = ''
  }

  private updateComposition(text: string) {
    const { deletes, insert } = textDiff(this.composed, text)
    for (let i = 0; i < deletes; i++) this.press(XK_BACKSPACE)
    this.type(insert)
    this.composed = text
  }

  private type(text: string) {
    for (const ch of Array.from(text)) this.press(charToKeysym(ch))
  }

  private press(keysym: number) {
    this.keyDown(keysym)
    this.keyUp(keysym)
  }

  private needsShift(keysym: number) {
    return this.touch() && keysymNeedsShift(keysym) && !this.shiftHeld() && !this.capsLock
  }
}
