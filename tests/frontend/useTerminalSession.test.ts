
import { describe, expect, it, vi } from 'vitest'
import { useTerminalSession } from '../../source/frontend/composables/useTerminalSession'
import type { TerminalTransport } from '../../source/frontend/services/terminalTransport'

describe('useTerminalSession', () => {
  it('starts disconnected without a transport', () => {
    const session = useTerminalSession()

    expect(session.status.value).toBe('idle')
    expect(session.isConnected.value).toBe(false)
    expect(session.canConnect.value).toBe(false)
    expect(session.sessionId.value).toBeNull()
  })

  it('provides the local target by default', () => {
    const session = useTerminalSession()

    expect(session.targets.value).toEqual([
      {
        id: 'local',
        label: 'Local',
        kind: 'local',
      },
    ])

    expect(session.selectedTarget.value?.id).toBe('local')
  })

  it('prevents concurrent connection attempts', async () => {
    let resolveConnect!: (value: { sessionId: string }) => void

    const connectPromise = new Promise<{ sessionId: string }>(
      resolve => {
        resolveConnect = resolve
      },
    )

    const connectMock = vi.fn().mockReturnValue(connectPromise)

    const transport: TerminalTransport = {
      connect: connectMock,
      write: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      onOutput: vi.fn().mockReturnValue(() => {}),
      onExit: vi.fn().mockReturnValue(() => {}),
    }

    const session = useTerminalSession(transport)

    const firstAttempt = session.connect(80, 24)
    const secondAttempt = session.connect(80, 24)

    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(session.status.value).toBe('connecting')
    expect(session.isBusy.value).toBe(true)

    resolveConnect({ sessionId: 'test-session-1' })

    await Promise.all([firstAttempt, secondAttempt])

    expect(session.status.value).toBe('connected')
    expect(session.sessionId.value).toBe('test-session-1')
    expect(session.isConnected.value).toBe(true)
  })

  it('closes a late connection after dispose', async () => {
    let resolveConnect!: (value: { sessionId: string }) => void

    const pendingConnect = new Promise<{ sessionId: string }>(
      resolve => {
        resolveConnect = resolve
      },
    )

    const disconnectMock = vi.fn().mockResolvedValue(undefined)

    const transport: TerminalTransport = {
      connect: vi.fn().mockReturnValue(pendingConnect),
      write: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      disconnect: disconnectMock,
      onOutput: vi.fn().mockReturnValue(() => {}),
      onExit: vi.fn().mockReturnValue(() => {}),
    }

    const session = useTerminalSession(transport)

    const attempt = session.connect(80, 24)

    expect(session.status.value).toBe('connecting')

    session.dispose()

    expect(session.status.value).toBe('disconnected')
    expect(session.sessionId.value).toBeNull()

    resolveConnect({ sessionId: 'late-session' })
    await attempt

    expect(disconnectMock).toHaveBeenCalledTimes(1)
    expect(session.status.value).toBe('disconnected')
    expect(session.sessionId.value).toBeNull()
  })

  it('does not disconnect twice when disposed during disconnect', async () => {
    let resolveDisconnect!: () => void

    const pendingDisconnect = new Promise<void>(resolve => {
      resolveDisconnect = resolve
    })

    const disconnectMock = vi.fn().mockReturnValue(pendingDisconnect)

    const transport: TerminalTransport = {
      connect: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
      }),
      write: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      disconnect: disconnectMock,
      onOutput: vi.fn().mockReturnValue(() => {}),
      onExit: vi.fn().mockReturnValue(() => {}),
    }

    const session = useTerminalSession(transport)

    await session.connect(80, 24)

    expect(session.status.value).toBe('connected')

    const disconnectAttempt = session.disconnect()

    expect(disconnectMock).toHaveBeenCalledTimes(1)

    session.dispose()

    expect(disconnectMock).toHaveBeenCalledTimes(1)
    expect(session.status.value).toBe('disconnected')

    resolveDisconnect()
    await disconnectAttempt

    expect(disconnectMock).toHaveBeenCalledTimes(1)
    expect(session.status.value).toBe('disconnected')
    expect(session.sessionId.value).toBeNull()
  })

  it('handles concurrent disconnect requests safely', async () => {
    let resolveDisconnect!: () => void

    const pendingDisconnect = new Promise<void>(resolve => {
      resolveDisconnect = resolve
    })

    const disconnectMock = vi.fn().mockReturnValue(pendingDisconnect)

    const transport: TerminalTransport = {
      connect: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
      }),
      write: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      disconnect: disconnectMock,
      onOutput: vi.fn().mockReturnValue(() => {}),
      onExit: vi.fn().mockReturnValue(() => {}),
    }

    const session = useTerminalSession(transport)

    await session.connect(80, 24)

    const first = session.disconnect()
    const second = session.disconnect()

    expect(disconnectMock).toHaveBeenCalledTimes(1)

    resolveDisconnect()

    await Promise.all([first, second])

    expect(disconnectMock).toHaveBeenCalledTimes(1)
    expect(session.status.value).toBe('disconnected')
    expect(session.sessionId.value).toBeNull()
  })

  it('tracks disconnecting state until cleanup completes', async () => {
    let resolveDisconnect!: () => void

    const pendingDisconnect = new Promise<void>(resolve => {
      resolveDisconnect = resolve
    })

    const transport: TerminalTransport = {
      connect: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
      }),
      write: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockReturnValue(pendingDisconnect),
      onOutput: vi.fn().mockReturnValue(() => {}),
      onExit: vi.fn().mockReturnValue(() => {}),
    }

    const session = useTerminalSession(transport)

    await session.connect(80, 24)

    expect(session.status.value).toBe('connected')

    const closing = session.disconnect()

    expect(session.status.value).toBe('disconnecting')
    expect(session.isBusy.value).toBe(true)
    expect(session.isConnected.value).toBe(false)
    expect(session.canConnect.value).toBe(false)
    expect(session.sessionId.value).toBe('session-1')

    resolveDisconnect()
    await closing

    expect(session.status.value).toBe('disconnected')
    expect(session.isBusy.value).toBe(false)
    expect(session.sessionId.value).toBeNull()
    expect(session.canConnect.value).toBe(true)
  })

  it('blocks reconnect while disconnect is pending', async () => {
    let resolveDisconnect!: () => void

    const pendingDisconnect = new Promise<void>(resolve => {
      resolveDisconnect = resolve
    })

    const connectMock = vi.fn()
      .mockResolvedValueOnce({ sessionId: 'session-1' })
      .mockResolvedValueOnce({ sessionId: 'session-2' })

    const disconnectMock = vi.fn().mockReturnValue(pendingDisconnect)

    const transport: TerminalTransport = {
      connect: connectMock,
      write: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      disconnect: disconnectMock,
      onOutput: vi.fn().mockReturnValue(() => {}),
      onExit: vi.fn().mockReturnValue(() => {}),
    }

    const session = useTerminalSession(transport)

    await session.connect(80, 24)

    expect(session.sessionId.value).toBe('session-1')

    const closing = session.disconnect()

    expect(disconnectMock).toHaveBeenCalledTimes(1)

    // A new session must not start while the old one is closing.
    await session.connect(80, 24)

    expect(connectMock).toHaveBeenCalledTimes(1)

    resolveDisconnect()
    await closing

    expect(session.status.value).toBe('disconnected')
    expect(session.sessionId.value).toBeNull()

    // Reconnecting is allowed after cleanup completes.
    await session.connect(80, 24)

    expect(connectMock).toHaveBeenCalledTimes(2)
    expect(session.sessionId.value).toBe('session-2')
  })

  it('retries disconnect after a cleanup failure', async () => {
    const disconnectMock = vi.fn()
      .mockRejectedValueOnce(new Error('Temporary cleanup failure'))
      .mockResolvedValueOnce(undefined)

    const transport: TerminalTransport = {
      connect: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
      }),
      write: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      disconnect: disconnectMock,
      onOutput: vi.fn().mockReturnValue(() => {}),
      onExit: vi.fn().mockReturnValue(() => {}),
    }

    const session = useTerminalSession(transport)

    await session.connect(80, 24)

    // First cleanup attempt fails.
    await session.disconnect()

    expect(disconnectMock).toHaveBeenCalledTimes(1)
    expect(session.status.value).toBe('error')
    expect(session.sessionId.value).toBe('session-1')
    expect(session.canConnect.value).toBe(false)

    // Retry closing the same session.
    await session.disconnect()

    expect(disconnectMock).toHaveBeenCalledTimes(2)
    expect(session.status.value).toBe('disconnected')
    expect(session.sessionId.value).toBeNull()
    expect(session.canConnect.value).toBe(true)
  })

  it('blocks reconnect after a failed disconnect', async () => {
    const connectMock = vi.fn().mockResolvedValue({
      sessionId: 'session-1',
    })

    const disconnectMock = vi.fn().mockRejectedValue(
      new Error('Session cleanup failed'),
    )

    const transport: TerminalTransport = {
      connect: connectMock,
      write: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      disconnect: disconnectMock,
      onOutput: vi.fn().mockReturnValue(() => {}),
      onExit: vi.fn().mockReturnValue(() => {}),
    }

    const session = useTerminalSession(transport)

    await session.connect(80, 24)

    expect(session.status.value).toBe('connected')

    await session.disconnect()

    expect(session.status.value).toBe('error')
    expect(session.error.value).toBe('Session cleanup failed')

    // The session may still exist on the server.
    expect(session.sessionId.value).toBe('session-1')

    // Reconnection must remain blocked.
    expect(session.canConnect.value).toBe(false)

    await session.connect(80, 24)

    expect(connectMock).toHaveBeenCalledTimes(1)
  })

})
