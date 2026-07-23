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

  it('emits pong and arms deadline after first ping', () => {
    const ws = makeMockWs()
    const hb = new WebSocketHeartbeat(500, 5000)
    hb.start(ws as any)
    // First ping arms the deadline
    vi.advanceTimersByTime(600)
    expect(ws.ping).toHaveBeenCalledTimes(1)
    // Emit pong — should reset pong timeout
    ws.emit('pong')
    // Advance past the next ping interval
    vi.advanceTimersByTime(500)
    expect(ws.ping).toHaveBeenCalledTimes(2)
  })

  it('rejects when pong deadline elapses with no pong', () => {
    const ws = makeMockWs()
    const hb = new WebSocketHeartbeat(500, 1000)
    const reject = vi.fn()
    hb.start(ws as any, reject)
    // First ping arms the deadline (1000ms)
    vi.advanceTimersByTime(600)
    expect(ws.ping).toHaveBeenCalledTimes(1)
    // Advance past the pong deadline without emitting pong
    vi.advanceTimersByTime(1100)
    expect(reject).toHaveBeenCalled()
    expect(reject.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(reject.mock.calls[0][0].message).toMatch(/heartbeat timeout/)
  })

  it('closes websocket when pong deadline elapses', () => {
    const ws = makeMockWs()
    const hb = new WebSocketHeartbeat(500, 1000)
    hb.start(ws as any, () => {})
    vi.advanceTimersByTime(600) // first ping, arms deadline
    vi.advanceTimersByTime(1100) // deadline elapses
    expect(ws.close).toHaveBeenCalled()
  })

  it('stops heartbeat on websocket error event', () => {
    const ws = makeMockWs()
    const hb = new WebSocketHeartbeat(500, 5000)
    hb.start(ws as any)
    ws.emit('error', new Error('socket died'))
    // Advance timers; interval should have been cleared so no more pings
    vi.advanceTimersByTime(2000)
    expect(ws.ping).toHaveBeenCalledTimes(0)
  })

  it('stops heartbeat on websocket close event', () => {
    const ws = makeMockWs()
    const hb = new WebSocketHeartbeat(500, 5000)
    hb.start(ws as any)
    vi.advanceTimersByTime(600) // first ping
    ws.emit('close')
    const pingCountAfterClose = ws.ping.mock.calls.length
    vi.advanceTimersByTime(2000)
    expect(ws.ping.mock.calls.length).toBe(pingCountAfterClose)
  })

  it('skips ping while websocket is in CONNECTING state', () => {
    const ws = makeMockWs()
    ws.readyState = 0 // CONNECTING
    const hb = new WebSocketHeartbeat(500, 5000)
    hb.start(ws as any)
    vi.advanceTimersByTime(2000)
    expect(ws.ping).not.toHaveBeenCalled()
  })

  it('stops heartbeat when websocket transitions to CLOSING', () => {
    const ws = makeMockWs()
    const hb = new WebSocketHeartbeat(500, 5000)
    hb.start(ws as any)
    vi.advanceTimersByTime(600) // OPEN → first ping fires
    ws.readyState = 2 // CLOSING
    vi.advanceTimersByTime(600) // next tick sees CLOSING → stop
    const pingsAfterTransition = ws.ping.mock.calls.length
    vi.advanceTimersByTime(2000)
    expect(ws.ping.mock.calls.length).toBe(pingsAfterTransition)
  })

  it('catches errors thrown by ws.ping without crashing', () => {
    const ws = makeMockWs()
    ws.ping = vi.fn(() => {
      throw new Error('ping failed')
    })
    const hb = new WebSocketHeartbeat(500, 5000)
    hb.start(ws as any)
    vi.advanceTimersByTime(600)
    // ping threw → heartbeat should stop, no further pings
    vi.advanceTimersByTime(2000)
    expect(ws.ping).toHaveBeenCalledTimes(1)
  })

  it('catches errors thrown by ws.close during pong deadline', () => {
    const ws = makeMockWs()
    ws.close = vi.fn(() => {
      throw new Error('already closing')
    })
    const hb = new WebSocketHeartbeat(500, 1000)
    hb.start(ws as any, () => {})
    vi.advanceTimersByTime(600) // first ping arms deadline
    vi.advanceTimersByTime(1100) // deadline elapses → close() throws, swallowed
    // Test passes if no uncaught exception was thrown
    expect(ws.close).toHaveBeenCalled()
  })
})
