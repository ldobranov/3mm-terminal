
import { describe, expect, it, vi } from 'vitest'
import { useTerminalSession } from '../../source/frontend/composables/useTerminalSession'
import type {
  TerminalSession,
  TerminalTransport,
} from '../../source/frontend/services/terminalTransport'

function createSession(sessionId: string): TerminalSession {
  return {
    sessionId,
    write: vi.fn().mockResolvedValue(undefined),
    resize: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    onOutput: vi.fn().mockReturnValue(() => {}),
    onExit: vi.fn().mockReturnValue(() => {}),
  }
}

function createTransport(
  connect: TerminalTransport['connect'],
): TerminalTransport {
  return { connect }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void

  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

describe('useTerminalSession', () => {
  it('starts disconnected without a transport', () => {
    const terminal = useTerminalSession()

    expect(terminal.status.value).toBe('idle')
    expect(terminal.sessionId.value).toBeNull()
    expect(terminal.isConnected.value).toBe(false)
    expect(terminal.canConnect.value).toBe(false)
  })

  it('provides the local target by default', () => {
    const terminal = useTerminalSession()

    expect(terminal.targets.value).toEqual([
      { id: 'local', label: 'Local', kind: 'local' },
    ])
    expect(terminal.selectedTarget.value?.id).toBe('local')
  })

  it('connects and owns the returned session', async () => {
    const owned = createSession('session-1')
    const connect = vi.fn().mockResolvedValue(owned)
    const terminal = useTerminalSession(
      createTransport(connect),
    )

    await terminal.connect(80, 24)

    expect(connect).toHaveBeenCalledWith({
      targetId: 'local',
      cols: 80,
      rows: 24,
    })
    expect(terminal.sessionId.value).toBe('session-1')
    expect(terminal.status.value).toBe('connected')
    expect(terminal.isConnected.value).toBe(true)
  })

  it('prevents concurrent connection attempts', async () => {
    const pending = deferred<TerminalSession>()
    const connect = vi.fn().mockReturnValue(pending.promise)
    const terminal = useTerminalSession(
      createTransport(connect),
    )

    const first = terminal.connect(80, 24)
    const second = terminal.connect(80, 24)

    expect(connect).toHaveBeenCalledTimes(1)
    expect(terminal.status.value).toBe('connecting')
    expect(terminal.isBusy.value).toBe(true)

    pending.resolve(createSession('session-1'))
    await Promise.all([first, second])

    expect(terminal.status.value).toBe('connected')
    expect(terminal.sessionId.value).toBe('session-1')
  })

  it('closes only a late session after disposal', async () => {
    const pending = deferred<TerminalSession>()
    const late = createSession('late-session')
    const terminal = useTerminalSession(
      createTransport(
        vi.fn().mockReturnValue(pending.promise),
      ),
    )

    const attempt = terminal.connect(80, 24)
    terminal.dispose()

    pending.resolve(late)
    await attempt

    expect(late.disconnect).toHaveBeenCalledTimes(1)
    expect(terminal.sessionId.value).toBeNull()
    expect(terminal.status.value).toBe('disconnected')
  })

  it('disconnects the owned session', async () => {
    const owned = createSession('session-1')
    const terminal = useTerminalSession(
      createTransport(vi.fn().mockResolvedValue(owned)),
    )

    await terminal.connect(80, 24)
    await terminal.disconnect()

    expect(owned.disconnect).toHaveBeenCalledTimes(1)
    expect(terminal.sessionId.value).toBeNull()
    expect(terminal.status.value).toBe('disconnected')
    expect(terminal.canConnect.value).toBe(true)
  })

  it('shares one cleanup across concurrent disconnects', async () => {
    const pending = deferred<void>()
    const owned = createSession('session-1')
    const disconnect = vi.fn().mockReturnValue(pending.promise)
    owned.disconnect = disconnect

    const terminal = useTerminalSession(
      createTransport(vi.fn().mockResolvedValue(owned)),
    )

    await terminal.connect(80, 24)

    const first = terminal.disconnect()
    const second = terminal.disconnect()

    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(terminal.status.value).toBe('disconnecting')

    pending.resolve()
    await Promise.all([first, second])

    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(terminal.status.value).toBe('disconnected')
  })

  it('blocks reconnect while cleanup is pending', async () => {
    const pending = deferred<void>()
    const firstSession = createSession('session-1')
    const secondSession = createSession('session-2')

    firstSession.disconnect = vi.fn().mockReturnValue(
      pending.promise,
    )

    const connect = vi.fn()
      .mockResolvedValueOnce(firstSession)
      .mockResolvedValueOnce(secondSession)

    const terminal = useTerminalSession(
      createTransport(connect),
    )

    await terminal.connect(80, 24)

    const closing = terminal.disconnect()
    await terminal.connect(80, 24)

    expect(connect).toHaveBeenCalledTimes(1)
    expect(terminal.canConnect.value).toBe(false)

    pending.resolve()
    await closing

    await terminal.connect(80, 24)

    expect(connect).toHaveBeenCalledTimes(2)
    expect(terminal.sessionId.value).toBe('session-2')
    expect(firstSession.disconnect).toHaveBeenCalledTimes(1)
    expect(secondSession.disconnect).not.toHaveBeenCalled()
  })

  it('keeps ownership after failed cleanup for retry', async () => {
    const owned = createSession('session-1')
    const disconnect = vi.fn()
      .mockRejectedValueOnce(new Error('Cleanup failed'))
      .mockResolvedValueOnce(undefined)

    owned.disconnect = disconnect

    const terminal = useTerminalSession(
      createTransport(vi.fn().mockResolvedValue(owned)),
    )

    await terminal.connect(80, 24)
    await terminal.disconnect()

    expect(terminal.status.value).toBe('error')
    expect(terminal.error.value).toBe('Cleanup failed')
    expect(terminal.sessionId.value).toBe('session-1')
    expect(terminal.canConnect.value).toBe(false)

    await terminal.disconnect()

    expect(disconnect).toHaveBeenCalledTimes(2)
    expect(terminal.sessionId.value).toBeNull()
    expect(terminal.status.value).toBe('disconnected')
  })

  it('disposal does not duplicate pending cleanup', async () => {
    const pending = deferred<void>()
    const owned = createSession('session-1')
    const disconnect = vi.fn().mockReturnValue(pending.promise)
    owned.disconnect = disconnect

    const terminal = useTerminalSession(
      createTransport(vi.fn().mockResolvedValue(owned)),
    )

    await terminal.connect(80, 24)

    const closing = terminal.disconnect()
    terminal.dispose()

    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(terminal.sessionId.value).toBeNull()

    pending.resolve()
    await closing

    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(terminal.status.value).toBe('disconnected')
  })

  it('disposal closes an active owned session', async () => {
    const owned = createSession('session-1')
    const terminal = useTerminalSession(
      createTransport(vi.fn().mockResolvedValue(owned)),
    )

    await terminal.connect(80, 24)
    terminal.dispose()
    terminal.dispose()

    expect(owned.disconnect).toHaveBeenCalledTimes(1)
    expect(terminal.canConnect.value).toBe(false)
    expect(terminal.sessionId.value).toBeNull()
  })

  it('reports connection failure and permits retry', async () => {
    const owned = createSession('session-2')
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockResolvedValueOnce(owned)

    const terminal = useTerminalSession(
      createTransport(connect),
    )

    await terminal.connect(80, 24)

    expect(terminal.status.value).toBe('error')
    expect(terminal.error.value).toBe('Unavailable')
    expect(terminal.canConnect.value).toBe(true)

    await terminal.connect(80, 24)

    expect(terminal.status.value).toBe('connected')
    expect(terminal.sessionId.value).toBe('session-2')
    expect(terminal.error.value).toBeNull()
  })
})
