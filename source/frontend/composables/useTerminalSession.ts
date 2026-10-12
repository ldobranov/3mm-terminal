
import { computed, ref } from 'vue'
import type {
  TerminalTransport,
  TerminalSessionOptions,
} from '../services/terminalTransport'

export type TerminalSessionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'disconnected'
  | 'error'

export interface TerminalTarget {
  id: string
  label: string
  kind: 'local' | 'remote'
}

export function useTerminalSession(
  transport: TerminalTransport | null = null,
) {
  const status = ref<TerminalSessionStatus>('idle')
  const error = ref<string | null>(null)
  const sessionId = ref<string | null>(null)
  let operationId = 0
  let disposed = false
  let pendingDisconnect: Promise<void> | null = null

  const targets = ref<TerminalTarget[]>([
    {
      id: 'local',
      label: 'Local',
      kind: 'local',
    },
  ])

  const selectedTargetId = ref('local')

  const selectedTarget = computed(() =>
    targets.value.find(
      target => target.id === selectedTargetId.value,
    ) ?? null,
  )

  const isConnected = computed(
    () => status.value === 'connected',
  )

  const isBusy = computed(
    () =>
      status.value === 'connecting' ||
      status.value === 'disconnecting',
  )

  const canConnect = computed(
    () =>
      !disposed &&
      transport !== null &&
      sessionId.value === null &&
      pendingDisconnect === null &&
      selectedTarget.value !== null &&
      (status.value === 'idle' ||
        status.value === 'disconnected' ||
        status.value === 'error'),
  )

  async function connect(cols: number, rows: number): Promise<void> {
    if (
      disposed ||
      !transport ||
      !canConnect.value ||
      !selectedTarget.value
    ) {
      return
    }

    const currentOperation = ++operationId

    const options: TerminalSessionOptions = {
      targetId: selectedTarget.value.id,
      cols,
      rows,
    }

    error.value = null
    status.value = 'connecting'

    try {
      const session = await transport.connect(options)

      if (disposed || currentOperation !== operationId) {
        await transport.disconnect()
        return
      }

      sessionId.value = session.sessionId
      status.value = 'connected'
    } catch (cause) {
      if (disposed || currentOperation !== operationId) {
        return
      }

      sessionId.value = null
      error.value =
        cause instanceof Error ? cause.message : 'Connection failed'
      status.value = 'error'
    }
  }

  function closeTransport(): Promise<void> {
    if (!transport) {
      return Promise.resolve()
    }

    if (pendingDisconnect) {
      return pendingDisconnect
    }

    let operation: Promise<void>

    try {
      operation = Promise.resolve(transport.disconnect())
    } catch (cause) {
      operation = Promise.reject(cause)
    }

    pendingDisconnect = operation

    void operation.then(
      () => {
        if (pendingDisconnect === operation) {
          pendingDisconnect = null
        }
      },
      () => {
        if (pendingDisconnect === operation) {
          pendingDisconnect = null
        }
      },
    )

    return operation
  }

  async function disconnect(): Promise<void> {
    if (disposed || !transport || !sessionId.value) {
      return
    }

    const currentOperation = ++operationId

    status.value = 'disconnecting'
    error.value = null

    try {
      await closeTransport()

      if (disposed || currentOperation !== operationId) {
        return
      }

      sessionId.value = null
      status.value = 'disconnected'
      error.value = null
    } catch (cause) {
      if (disposed || currentOperation !== operationId) {
        return
      }

      error.value =
        cause instanceof Error ? cause.message : 'Disconnect failed'
      status.value = 'error'
    }
  }

  function reset(): void {
    if (sessionId.value || status.value === 'connecting') {
      return
    }

    status.value = 'idle'
    error.value = null
  }

  function dispose(): void {
    if (disposed) return

    disposed = true
    operationId++

    if (transport && sessionId.value) {
      void closeTransport().catch(() => {
        // Cleanup is best-effort.
      })
    }

    sessionId.value = null
    status.value = 'disconnected'
  }

  return {
    status,
    error,
    sessionId,
    targets,
    selectedTargetId,
    selectedTarget,
    isConnected,
    isBusy,
    canConnect,
    connect,
    disconnect,
    reset,
    dispose,
  }
}
