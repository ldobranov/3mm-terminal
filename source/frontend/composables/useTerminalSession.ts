
import { computed, ref, shallowRef } from 'vue'
import type {
  TerminalSession,
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

  // Session ownership must be reactive, but the session
  // object itself must not be converted to a Vue proxy.
  const activeSession = shallowRef<TerminalSession | null>(null)

  // Track asynchronous cleanup reactively so reconnect
  // becomes available only after cleanup has finished.
  const pendingDisconnect = shallowRef<Promise<void> | null>(
    null,
  )

  const disposed = ref(false)
  let operationId = 0

  const targets = ref<TerminalTarget[]>([
    {
      id: 'local',
      label: 'Local',
      kind: 'local',
    },
  ])

  const selectedTargetId = ref('local')

  const selectedTarget = computed(
    () =>
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
      !disposed.value &&
      transport !== null &&
      activeSession.value === null &&
      sessionId.value === null &&
      pendingDisconnect.value === null &&
      selectedTarget.value !== null &&
      (
        status.value === 'idle' ||
        status.value === 'disconnected' ||
        status.value === 'error'
      ),
  )

  async function connect(
    cols: number,
    rows: number,
  ): Promise<void> {
    if (
      disposed.value ||
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
      const newSession = await transport.connect(options)

      if (
        disposed.value ||
        currentOperation !== operationId
      ) {
        // This connection is no longer owned by us.
        // Close this exact session, not the transport
        // or any newer session.
        try {
          await newSession.disconnect()
        } catch {
          // Late cleanup is best-effort.
        }
        return
      }

      activeSession.value = newSession
      sessionId.value = newSession.sessionId
      status.value = 'connected'
    } catch (cause) {
      if (
        disposed.value ||
        currentOperation !== operationId
      ) {
        return
      }

      activeSession.value = null
      sessionId.value = null

      error.value =
        cause instanceof Error
          ? cause.message
          : 'Connection failed'

      status.value = 'error'
    }
  }

  function disconnect(): Promise<void> {
    if (disposed.value || !activeSession.value) {
      return Promise.resolve()
    }

    // Concurrent disconnect requests share one task.
    if (pendingDisconnect.value) {
      return pendingDisconnect.value
    }

    const ownedSession = activeSession.value

    status.value = 'disconnecting'
    error.value = null

    const task = (async (): Promise<void> => {
      try {
        await ownedSession.disconnect()

        if (
          !disposed.value &&
          activeSession.value === ownedSession
        ) {
          activeSession.value = null
          sessionId.value = null
          status.value = 'disconnected'
          error.value = null
        }
      } catch (cause) {
        if (
          !disposed.value &&
          activeSession.value === ownedSession
        ) {
          // The remote session might still exist.
          // Retain ownership so cleanup can be retried.
          error.value =
            cause instanceof Error
              ? cause.message
              : 'Disconnect failed'

          status.value = 'error'
        }
      }
    })()

    pendingDisconnect.value = task

    // Release the cleanup lock once the task settles.
    // The ref update also invalidates canConnect.
    void task.then(
      () => {
        if (pendingDisconnect.value === task) {
          pendingDisconnect.value = null
        }
      },
      () => {
        if (pendingDisconnect.value === task) {
          pendingDisconnect.value = null
        }
      },
    )

    return task
  }

  function reset(): void {
    if (
      disposed.value ||
      activeSession.value !== null ||
      status.value === 'connecting' ||
      pendingDisconnect.value !== null
    ) {
      return
    }

    status.value = 'idle'
    error.value = null
  }

  function dispose(): void {
    if (disposed.value) {
      return
    }

    disposed.value = true
    operationId++

    const ownedSession = activeSession.value

    // If a disconnect is already in progress,
    // do not invoke it for a second time.
    if (
      ownedSession &&
      pendingDisconnect.value === null
    ) {
      try {
        void Promise.resolve(
          ownedSession.disconnect(),
        ).catch(() => {
          // Cleanup on disposal is best-effort.
        })
      } catch {
        // Handle synchronous cleanup errors.
      }
    }

    activeSession.value = null
    sessionId.value = null
    error.value = null
    status.value = 'disconnected'
  }

  return {
    status,
    error,
    sessionId,
    activeSession,

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
