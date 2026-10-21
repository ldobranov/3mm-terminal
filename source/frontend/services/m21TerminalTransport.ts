
import type {
  TerminalSession,
  TerminalSessionOptions,
  TerminalTransport,
} from './terminalTransport'

const PROVIDER_ID = 'org.3mm.terminal'
const CAPABILITY_ID = 'org.3mm.terminal.shell'
// The local isolated worker accepts 16 KiB, below the M21 envelope ceiling.
// Chunk the byte stream at the narrowest supported input boundary.
const MAX_M21_PAYLOAD_BYTES = 16_384
const MAX_INITIAL_OUTPUT_BYTES = 64 * 1024

export interface M21Target {
  deviceId: string
  available: boolean
  capabilityIds: readonly string[]
  providerId?: string
  accessMode?: 'read' | 'write'
  options?: Readonly<Record<string, unknown>>
}

export interface M21OpenRequest {
  session_request_version: 1
  request_id: string
  provider_id: string
  capability_id: string
  device_id: string
  access_mode: 'write'
  options: {
    cols: number
    rows: number
  }
}

export interface M21OpenAcceptance {
  request_id: string
  session_id: string
  state: 'active'
  provider_id: string
  capability_id: string
  device_id: string
}

export interface M21ResizeControl {
  session_id: string
  control_id: string
  action: 'resize'
  arguments: {
    cols: number
    rows: number
  }
}

/**
 * Internal adapter boundary, NOT a new M21 platform API.
 *
 * The trusted application host supplies this through its
 * credential-free sessions interface. No extension-owned socket.
 *
 * It must preserve frame order, apply backpressure and buffer
 * initial output until observation has been established.
 */
export interface M21AuthorizedBridge {
  resolveTarget(targetId: string): Promise<M21Target>

  open(request: M21OpenRequest): Promise<M21OpenAcceptance>

  sendData(
    sessionId: string,
    payload: Uint8Array,
  ): Promise<void>

  control(message: M21ResizeControl): Promise<void>

  close(sessionId: string): Promise<void>

  observe(
    sessionId: string,
    callbacks: {
      onData(data: Uint8Array): void
      onClosed(): void
    },
  ): () => void
}

function newRequestId(): string {
  return `terminal_${crypto.randomUUID().replace(/-/g, '')}`
}

function validSize(cols: number, rows: number): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= 1 &&
    cols <= 500 &&
    rows >= 1 &&
    rows <= 200
  )
}

export class M21TerminalTransport implements TerminalTransport {
  constructor(
    private readonly bridge: M21AuthorizedBridge,
  ) {}

  async connect(
    options: TerminalSessionOptions,
  ): Promise<TerminalSession> {
    if (!validSize(options.cols, options.rows)) {
      throw new Error('Invalid terminal dimensions')
    }

    const target = await this.bridge.resolveTarget(
      options.targetId,
    )

    if (
      !target.available ||
      target.providerId !== undefined && target.providerId !== PROVIDER_ID ||
      target.accessMode !== undefined && target.accessMode !== 'write' ||
      !target.capabilityIds.includes(CAPABILITY_ID) ||
      !/^dev_[0-9a-f]{32}$/.test(target.deviceId)
    ) {
      throw new Error(
        'Authorized terminal target is unavailable',
      )
    }

    const requestId = newRequestId()
    // M20 approves exact opening options, not arbitrary browser dimensions.
    // Subsequent size changes use the separately approved resize control.
    const opening = target.options === undefined ? { cols: options.cols, rows: options.rows } : target.options
    if (Object.keys(opening).sort().join() !== 'cols,rows'
      || !validSize(Number(opening.cols), Number(opening.rows))
      || typeof opening.cols !== 'number' || typeof opening.rows !== 'number') {
      throw new Error('Reviewed terminal opening options are unavailable')
    }

    const accepted = await this.bridge.open({
      session_request_version: 1,
      request_id: requestId,
      provider_id: PROVIDER_ID,
      capability_id: CAPABILITY_ID,
      device_id: target.deviceId,
      access_mode: 'write',
      options: {
        cols: opening.cols,
        rows: opening.rows,
      },
    })

    if (
      accepted.request_id !== requestId ||
      accepted.state !== 'active' ||
      accepted.provider_id !== PROVIDER_ID ||
      accepted.capability_id !== CAPABILITY_ID ||
      accepted.device_id !== target.deviceId ||
      !/^ses_[0-9a-f]{32}$/.test(accepted.session_id)
    ) {
      throw new Error('Invalid M21 session acceptance')
    }

    const sessionId = accepted.session_id
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()

    const outputHandlers = new Set<
      (data: string) => void
    >()

    const exitHandlers = new Set<
      (code: number | null) => void
    >()

    let closed = false
    let pendingClose: Promise<void> | null = null
    let unsubscribe: (() => void) | null = null

    // Preserve output received before the UI subscribes.
    let initialOutput = ''
    let initialOutputBytes = 0
    // Serialize writes belonging to this session.
    // A failed write must not permanently block the queue.
    let writeQueue: Promise<void> = Promise.resolve()

    const finish = () => {
      if (closed) return
      closed = true

      unsubscribe?.()
      unsubscribe = null

      const remaining = decoder.decode()
      if (remaining) {
        for (const handler of outputHandlers) {
          handler(remaining)
        }
      }

      // M21 currently does not provide a shell exit code.
      for (const handler of exitHandlers) {
        handler(null)
      }

      outputHandlers.clear()
      exitHandlers.clear()
    }

    try {
      unsubscribe = this.bridge.observe(sessionId, {

        onData: (data) => {
          if (closed) return

          const hasSubscribers = outputHandlers.size > 0

          if (!hasSubscribers) {
            if (
              initialOutputBytes + data.byteLength >
              MAX_INITIAL_OUTPUT_BYTES
            ) {
              // Fail closed instead of silently losing output
              // or allowing unlimited memory consumption.
              finish()

              void this.bridge.close(sessionId).catch(() => {
                // The platform remains responsible for expiry.
              })

              return
            }

            initialOutputBytes += data.byteLength
          }

          const output = decoder.decode(data, {
            stream: true,
          })

          if (!output) return

          if (!hasSubscribers) {
            initialOutput += output
            return
          }

          for (const handler of outputHandlers) {
            handler(output)
          }
        },

        onClosed: finish,
      })

      if (closed) {
        unsubscribe()
        unsubscribe = null

        throw new Error(
          'M21 terminal session closed during connection setup',
        )
      }
    } catch (error) {
      // If already closed, cleanup was initiated by onData,
      // or the bridge reported that the session had ended.
      if (!closed) {
        try {
          await this.bridge.close(sessionId)
        } catch {
          // The platform must also enforce session expiry.
        }
      }

      throw error
    }

    return {
      sessionId,

    write: (data: string): Promise<void> => {
      if (closed || pendingClose) {
        return Promise.reject(
          new Error('Terminal session is closed'),
        )
      }

      if (!data) {
        return Promise.resolve()
      }

      const bytes = encoder.encode(data)

      // Reserve a position in the session's FIFO queue.
      const operation = writeQueue.then(async () => {
        if (closed || pendingClose) {
          throw new Error('Terminal session is closed')
        }

        for (
          let offset = 0;
          offset < bytes.length;
          offset += MAX_M21_PAYLOAD_BYTES
        ) {
          if (closed || pendingClose) {
            throw new Error('Terminal session is closed')
          }

          const chunk = bytes.subarray(
            offset,
            Math.min(
              offset + MAX_M21_PAYLOAD_BYTES,
              bytes.length,
            ),
          )

          // Backpressure: wait for each frame before
          // proceeding to the next one.
          await this.bridge.sendData(sessionId, chunk)
        }
      })

      // Preserve FIFO ordering even if an earlier write
      // failed. Its error still reaches its own caller.
      writeQueue = operation.catch(() => {})

      return operation
    },

      resize: async (cols: number, rows: number) => {
        if (closed) {
          throw new Error('Terminal session is closed')
        }

        if (!validSize(cols, rows)) {
          throw new Error('Invalid terminal dimensions')
        }

        await this.bridge.control({
          session_id: sessionId,
          control_id: newRequestId(),
          action: 'resize',
          arguments: { cols, rows },
        })
      },

      disconnect: (): Promise<void> => {
        if (closed) {
          return Promise.resolve()
        }

        if (pendingClose) {
          return pendingClose
        }

        // Wait for the current write operation to settle.
        // Once pendingClose is set, queued writes and
        // remaining chunks are rejected by write().
        const task = writeQueue
          .then(() => this.bridge.close(sessionId))
          .then(finish)
          .finally(() => {
            pendingClose = null
          })

        pendingClose = task

        return task
      },

      onOutput: (handler) => {
        if (!closed) {
          outputHandlers.add(handler)

          if (initialOutput) {
            const buffered = initialOutput

            initialOutput = ''
            initialOutputBytes = 0

            // Replay once to the first subscriber.
            handler(buffered)
          }
        }

        return () => {
          outputHandlers.delete(handler)
        }
      },

      onExit: (handler) => {
        if (!closed) exitHandlers.add(handler)

        return () => {
          exitHandlers.delete(handler)
        }
      },
    }
  }
}
