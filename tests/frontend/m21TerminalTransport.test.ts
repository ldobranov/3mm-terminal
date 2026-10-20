
import { describe, expect, it, vi } from 'vitest'

import {
  M21TerminalTransport,
  type M21AuthorizedBridge,
  type M21OpenAcceptance,
  type M21OpenRequest,
} from '../../source/frontend/services/m21TerminalTransport'

const DEVICE_ID = `dev_${'a'.repeat(32)}`
const SESSION_ID = `ses_${'b'.repeat(32)}`
const CAPABILITY_ID = 'org.3mm.terminal.shell'

type Observer = Parameters<
  M21AuthorizedBridge['observe']
>[1]

function createTestBridge() {
  const observers = new Map<string, Observer>()

  const bridge: M21AuthorizedBridge = {
    resolveTarget: vi.fn(async () => ({
      deviceId: DEVICE_ID,
      available: true,
      capabilityIds: [CAPABILITY_ID],
    })),

    open: vi.fn(
      async (
        request: M21OpenRequest,
      ): Promise<M21OpenAcceptance> => ({
        request_id: request.request_id,
        session_id: SESSION_ID,
        state: 'active',
        provider_id: request.provider_id,
        capability_id: request.capability_id,
        device_id: request.device_id,
      }),
    ),

    sendData: vi.fn(async () => {}),

    control: vi.fn(async () => {}),

    close: vi.fn(async () => {}),

    observe: vi.fn((sessionId, callbacks) => {
      observers.set(sessionId, callbacks)

      return () => {
        observers.delete(sessionId)
      }
    }),
  }

  return { bridge, observers }
}

describe('M21TerminalTransport', () => {
  it('opens with exact reviewed options rather than browser-selected dimensions', async () => {
    const { bridge } = createTestBridge()
    vi.mocked(bridge.resolveTarget).mockResolvedValue({ deviceId: DEVICE_ID, available: true,
      providerId: 'org.3mm.terminal', accessMode: 'write', capabilityIds: [CAPABILITY_ID], options: { cols: 80, rows: 24 } })
    const session = await new M21TerminalTransport(bridge).connect({ targetId: 'console', cols: 120, rows: 40 })
    expect(bridge.open).toHaveBeenCalledWith(expect.objectContaining({ options: { cols: 80, rows: 24 } }))
    await session.disconnect()
  })

  it.each(['provider', 'mode', 'options'])('does not open a session with changed reviewed %s', async fault => {
    const { bridge } = createTestBridge()
    vi.mocked(bridge.resolveTarget).mockResolvedValue({ deviceId: DEVICE_ID, available: true,
      providerId: fault === 'provider' ? 'org.example.other' : 'org.3mm.terminal',
      accessMode: fault === 'mode' ? 'read' : 'write', capabilityIds: [CAPABILITY_ID],
      options: fault === 'options' ? { cols: '80', rows: 24 } : { cols: 80, rows: 24 } })
    await expect(new M21TerminalTransport(bridge).connect({ targetId: 'console', cols: 80, rows: 24 })).rejects.toThrow()
    expect(bridge.open).not.toHaveBeenCalled()
  })

  it('opens an authorized M21 session', async () => {
    const { bridge } = createTestBridge()
    const transport = new M21TerminalTransport(bridge)

    const session = await transport.connect({
      targetId: 'local',
      cols: 80,
      rows: 24,
    })

    expect(session.sessionId).toBe(SESSION_ID)

    expect(bridge.resolveTarget).toHaveBeenCalledWith(
      'local',
    )

    expect(bridge.open).toHaveBeenCalledWith(
      expect.objectContaining({
        session_request_version: 1,
        provider_id: 'org.3mm.terminal',
        capability_id: CAPABILITY_ID,
        device_id: DEVICE_ID,
        access_mode: 'write',
        options: {
          cols: 80,
          rows: 24,
        },
      }),
    )
  })

  it('exchanges data, resizes and closes the session', async () => {
    const { bridge, observers } = createTestBridge()
    const transport = new M21TerminalTransport(bridge)

    const session = await transport.connect({
      targetId: 'local',
      cols: 80,
      rows: 24,
    })

    const output = vi.fn()
    const exited = vi.fn()

    session.onOutput(output)
    session.onExit(exited)

    await session.write('hello')

    expect(bridge.sendData).toHaveBeenCalledWith(
      SESSION_ID,
      new TextEncoder().encode('hello'),
    )

    observers.get(SESSION_ID)?.onData(
      new TextEncoder().encode('response'),
    )

    expect(output).toHaveBeenCalledWith('response')

    await session.resize(120, 40)

    expect(bridge.control).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: SESSION_ID,
        action: 'resize',
        arguments: {
          cols: 120,
          rows: 40,
        },
      }),
    )

    await session.disconnect()

    expect(bridge.close).toHaveBeenCalledWith(
      SESSION_ID,
    )

    expect(exited).toHaveBeenCalledWith(null)
    expect(observers.has(SESSION_ID)).toBe(false)

    await expect(
      session.write('after-close'),
    ).rejects.toThrow('closed')
  })

  it('rejects an unavailable terminal target', async () => {
    const { bridge } = createTestBridge()

    vi.mocked(bridge.resolveTarget).mockResolvedValue({
      deviceId: DEVICE_ID,
      available: false,
      capabilityIds: [CAPABILITY_ID],
    })

    const transport = new M21TerminalTransport(bridge)

    await expect(
      transport.connect({
        targetId: 'local',
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow(
      'Authorized terminal target is unavailable',
    )

    expect(bridge.open).not.toHaveBeenCalled()
  })

  it('splits large writes into ordered M21 frames', async () => {
    const { bridge } = createTestBridge()
    const transport = new M21TerminalTransport(bridge)

    const session = await transport.connect({
      targetId: 'local',
      cols: 80,
      rows: 24,
    })

    const text = 'A'.repeat(150_000)

    await session.write(text)

    const calls = vi.mocked(bridge.sendData).mock.calls

    expect(calls.length).toBeGreaterThan(1)

    const MAX_PAYLOAD_BYTES = 65_536 - 258

    for (const [sessionId, payload] of calls) {
      expect(sessionId).toBe(SESSION_ID)
      expect(payload.length).toBeLessThanOrEqual(
        MAX_PAYLOAD_BYTES,
      )
    }

    const merged = new Uint8Array(
      calls.reduce(
        (size, [, payload]) => size + payload.length,
        0,
      ),
    )

    let offset = 0

    for (const [, payload] of calls) {
      merged.set(payload, offset)
      offset += payload.length
    }

    expect(new TextDecoder().decode(merged)).toBe(text)
  })


  it('preserves order of concurrent writes', async () => {
    const { bridge } = createTestBridge()
    const transport = new M21TerminalTransport(bridge)

    const session = await transport.connect({
      targetId: 'local',
      cols: 80,
      rows: 24,
    })

    let releaseFirst!: () => void
    let signalStarted!: () => void

    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const started = new Promise<void>((resolve) => {
      signalStarted = resolve
    })

    // Block the first frame while another write starts.
    vi.mocked(bridge.sendData).mockImplementationOnce(
      async () => {
        signalStarted()
        await blocked
      },
    )

    const firstText = 'A'.repeat(150_000)

    const firstWrite = session.write(firstText)

    await started

    // This write must wait until ALL frames of
    // the first write have been sent.
    const secondWrite = session.write('B')

    releaseFirst()

    await Promise.all([firstWrite, secondWrite])

    const calls = vi.mocked(bridge.sendData).mock.calls

    const totalLength = calls.reduce(
      (sum, [, payload]) => sum + payload.length,
      0,
    )

    const merged = new Uint8Array(totalLength)

    let offset = 0

    for (const [, payload] of calls) {
      merged.set(payload, offset)
      offset += payload.length
    }

    expect(new TextDecoder().decode(merged)).toBe(
      firstText + 'B',
    )
  })


  it('waits for in-flight data before closing', async () => {
    const { bridge } = createTestBridge()
    const transport = new M21TerminalTransport(bridge)

    const session = await transport.connect({
      targetId: 'local',
      cols: 80,
      rows: 24,
    })

    let releaseFrame!: () => void
    let signalStarted!: () => void

    const blockedFrame = new Promise<void>((resolve) => {
      releaseFrame = resolve
    })

    const started = new Promise<void>((resolve) => {
      signalStarted = resolve
    })

    vi.mocked(bridge.sendData).mockImplementationOnce(
      async () => {
        signalStarted()
        await blockedFrame
      },
    )

    const writing = session.write('A'.repeat(150_000))

    await started

    // Request disconnect while the first frame
    // is still being processed.
    const disconnecting = session.disconnect()

    let results: PromiseSettledResult<void>[] = []

    try {
      // Closing the M21 session must wait until
      // the in-flight frame finishes.
      expect(bridge.close).not.toHaveBeenCalled()
    } finally {
      releaseFrame()

      results = await Promise.allSettled([
        writing,
        disconnecting,
      ])
    }

    // The interrupted multi-frame write is rejected.
    expect(results[0].status).toBe('rejected')

    // No remaining chunks are transmitted.
    expect(bridge.sendData).toHaveBeenCalledTimes(1)

    // M21 close happens exactly once.
    expect(bridge.close).toHaveBeenCalledTimes(1)
    expect(bridge.close).toHaveBeenCalledWith(
      SESSION_ID,
    )
  })


  it('closes after an in-flight write fails', async () => {
    const { bridge } = createTestBridge()
    const transport = new M21TerminalTransport(bridge)

    const session = await transport.connect({
      targetId: 'local',
      cols: 80,
      rows: 24,
    })

    let releaseFrame!: () => void
    let signalStarted!: () => void

    const blocked = new Promise<void>((resolve) => {
      releaseFrame = resolve
    })

    const started = new Promise<void>((resolve) => {
      signalStarted = resolve
    })

    vi.mocked(bridge.sendData).mockImplementationOnce(
      async () => {
        signalStarted()
        await blocked
        throw new Error('Simulated transport failure')
      },
    )

    const writing = session.write('A'.repeat(150_000))

    await started

    const disconnecting = session.disconnect()

    // The active frame must finish or fail
    // before the session is closed.
    expect(bridge.close).not.toHaveBeenCalled()

    releaseFrame()

    const results = await Promise.allSettled([
      writing,
      disconnecting,
    ])

    expect(results[0]).toMatchObject({
      status: 'rejected',
      reason: new Error('Simulated transport failure'),
    })

    expect(results[1]).toMatchObject({
      status: 'fulfilled',
    })

    // No additional chunks after the failed frame.
    expect(bridge.sendData).toHaveBeenCalledTimes(1)

    expect(bridge.close).toHaveBeenCalledTimes(1)
    expect(bridge.close).toHaveBeenCalledWith(
      SESSION_ID,
    )

    await expect(
      session.write('after-close'),
    ).rejects.toThrow('closed')
  })


  it('rejects an invalid M21 session acceptance', async () => {
    const { bridge } = createTestBridge()

    vi.mocked(bridge.open).mockImplementationOnce(
      async (request) => ({
        request_id: request.request_id,
        session_id: SESSION_ID,
        state: 'active',
        provider_id: 'org.invalid.provider',
        capability_id: request.capability_id,
        device_id: request.device_id,
      }),
    )

    const transport = new M21TerminalTransport(bridge)

    await expect(
      transport.connect({
        targetId: 'local',
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow(
      'Invalid M21 session acceptance',
    )

    // No session may be exposed to the frontend
    // after a mismatched M21 acceptance.
    expect(bridge.observe).not.toHaveBeenCalled()
    expect(bridge.sendData).not.toHaveBeenCalled()
    expect(bridge.control).not.toHaveBeenCalled()
  })

  it('fails closed when the M21 session ends unexpectedly', async () => {
    const { bridge, observers } = createTestBridge()
    const transport = new M21TerminalTransport(bridge)

    const session = await transport.connect({
      targetId: 'local',
      cols: 80,
      rows: 24,
    })

    const exited = vi.fn()
    const output = vi.fn()

    session.onExit(exited)
    session.onOutput(output)

    const observer = observers.get(SESSION_ID)

    expect(observer).toBeDefined()

    // Simulate the platform reporting a lost
    // or terminated interactive session.
    observer?.onClosed()
    observer?.onClosed()

    // Exit must be reported only once.
    expect(exited).toHaveBeenCalledTimes(1)
    expect(exited).toHaveBeenCalledWith(null)

    expect(observers.has(SESSION_ID)).toBe(false)

    await expect(
      session.write('after-disconnect'),
    ).rejects.toThrow('closed')

    await expect(
      session.resize(120, 40),
    ).rejects.toThrow('closed')

    observer?.onData(
      new TextEncoder().encode('late-output'),
    )

    expect(output).not.toHaveBeenCalled()

    // The remote session already ended.
    // Do not issue another close automatically.
    expect(bridge.close).not.toHaveBeenCalled()
  })


  it('preserves initial output until the UI subscribes', async () => {
    const { bridge } = createTestBridge()

    const banner = 'Готово: terminal ready\r\n'
    const bytes = new TextEncoder().encode(banner)

    // Simulate M21 data arriving immediately
    // when the session observer is registered.
    vi.mocked(bridge.observe).mockImplementationOnce(
      (_sessionId, callbacks) => {
        // Split inside the first UTF-8 character.
        callbacks.onData(bytes.subarray(0, 1))
        callbacks.onData(bytes.subarray(1))

        return () => {}
      },
    )

    const transport = new M21TerminalTransport(bridge)

    const session = await transport.connect({
      targetId: 'local',
      cols: 80,
      rows: 24,
    })

    // The UI subscribes only after connect().
    const output = vi.fn()

    session.onOutput(output)

    expect(output).toHaveBeenCalledTimes(1)
    expect(output).toHaveBeenCalledWith(banner)
  })

  it('rejects connect when initial output overflows', async () => {
    const { bridge } = createTestBridge()

    vi.mocked(bridge.observe).mockImplementationOnce(
      (_sessionId, callbacks) => {
        // Both frames are individually within M21 limits,
        // but together exceed the 64 KiB startup buffer.
        callbacks.onData(
          new Uint8Array(40 * 1024).fill(65),
        )

        callbacks.onData(
          new Uint8Array(30 * 1024).fill(66),
        )

        return () => {}
      },
    )

    const transport = new M21TerminalTransport(bridge)

    // A connection that already failed during startup
    // must not be exposed as an active session.
    await expect(
      transport.connect({
        targetId: 'local',
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow()

    // The rejected startup must also request
    // cleanup of the accepted M21 session.
    expect(bridge.close).toHaveBeenCalledTimes(1)
    expect(bridge.close).toHaveBeenCalledWith(
      SESSION_ID,
    )
  })

  it('cleans up when M21 closes during observer registration', async () => {
    const { bridge } = createTestBridge()

    const unsubscribe = vi.fn()

    vi.mocked(bridge.observe).mockImplementationOnce(
      (_sessionId, callbacks) => {
        // Platform closes before observe() returns.
        callbacks.onClosed()

        return unsubscribe
      },
    )

    const transport = new M21TerminalTransport(bridge)

    await expect(
      transport.connect({
        targetId: 'local',
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow(
      'M21 terminal session closed during connection setup',
    )

    // The observer must be released exactly once.
    expect(unsubscribe).toHaveBeenCalledTimes(1)

    // The platform has already closed the session.
    expect(bridge.close).not.toHaveBeenCalled()

    expect(bridge.sendData).not.toHaveBeenCalled()
    expect(bridge.control).not.toHaveBeenCalled()
  })

})
