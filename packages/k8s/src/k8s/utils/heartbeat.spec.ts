import { parsePositiveMsEnv, WebSocketHeartbeat } from '../heartbeat'

vi.mock('@actions/core', () => ({
  debug: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn()
}))

// ── parsePositiveMsEnv ────────────────────────────────────────────────────────

describe('parsePositiveMsEnv', () => {
  it('returns fallback when value is undefined', () => {
    expect(parsePositiveMsEnv(undefined, 500)).toBe(500)
  })

  it('returns fallback when value is empty string', () => {
    expect(parsePositiveMsEnv('', 500)).toBe(500)
  })

  it('returns fallback when value is non-numeric', () => {
    expect(parsePositiveMsEnv('bad', 500)).toBe(500)
  })

  it('returns fallback when value is zero', () => {
    expect(parsePositiveMsEnv('0', 500)).toBe(500)
  })

  it('returns fallback when value is negative', () => {
    expect(parsePositiveMsEnv('-100', 500)).toBe(500)
  })

  it('returns parsed value when positive integer', () => {
    expect(parsePositiveMsEnv('3000', 500)).toBe(3000)
  })

  it('returns parsed value for large numbers', () => {
    expect(parsePositiveMsEnv('60000', 500)).toBe(60000)
  })

  it('truncates float to integer', () => {
    expect(parsePositiveMsEnv('1500.9', 500)).toBe(1500)
  })
})

// ── WebSocketHeartbeat ────────────────────────────────────────────────────────

function makeMockWs() {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {}
  return {
    readyState: 1,
    ping: vi.fn(),
    close: vi.fn(),
    on(event: string, listener: (...args: any[]) => void) {
      listeners[event] = listeners[event] || []
      listeners[event].push(listener)
      return this
    },
    once(event: string, listener: (...args: any[]) => void) {
      listeners[event] = listeners[event] || []
      listeners[event].push(listener)
      return this
    },
    emit(event: string, ...args: any[]) {
      ;(listeners[event] || []).forEach(fn => fn(...args))
    }
  }
}

describe('WebSocketHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('start attaches and sends pings on interval', () => {
    const ws = makeMockWs()
    const hb = new WebSocketHeartbeat(1000, 2000)
    hb.start(ws as any)
    vi.advanceTimersByTime(1100)
    expect(ws.ping).toHaveBeenCalled()
  })

  it('stop clears intervals without throwing', () => {
    const ws = makeMockWs()
    const hb = new WebSocketHeartbeat(1000, 2000)
    hb.start(ws as any)
    expect(() => hb.stop()).not.toThrow()
  })

  it('stop is safe to call before start', () => {
    const hb = new WebSocketHeartbeat(1000, 2000)
    expect(() => hb.stop()).not.toThrow()
  })

  it('stop called after ping does not throw', () => {
    const ws = makeMockWs()
    const hb = new WebSocketHeartbeat(500, 5000)
    hb.start(ws as any)
    vi.advanceTimersByTime(600)
    expect(ws.ping).toHaveBeenCalled()
    hb.stop()
  })
})
