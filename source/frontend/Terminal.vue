
<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { useApplicationHost } from '@3mm/application-ui/v1'
import { M21TerminalTransport } from './services/m21TerminalTransport'
import { useTerminalSession } from './composables/useTerminalSession'
import type { TerminalSession } from './services/terminalTransport'
import { Terminal as XTerm, FitAddon } from './vendor/xterm-vendor.js'

const bridge = useApplicationHost().sessions
const controller = useTerminalSession(bridge ? new M21TerminalTransport(bridge) : null)

const {
  status,
  error,
  targets,
  selectedTargetId,
  selectedTarget,
  isConnected,
  isBusy,
} = controller
targets.value = []
selectedTargetId.value = ''
const terminalElement = ref<HTMLElement | null>(null)
let terminal: XTerm | null = null
let fitAddon: FitAddon | null = null
let keyboardSubscription: { dispose(): void } | null = null
let resizeSubscription: { dispose(): void } | null = null
let resizeObserver: ResizeObserver | null = null
let resizeQueue: Promise<void> = Promise.resolve()
let lastSize: { session: TerminalSession; cols: number; rows: number } | null = null
const input = ref('')
const discoveryError = ref('')
const discovering = ref(false)
let disposed = false
let removeOutput = () => {}
let removeExit = () => {}
const available = ref<string[]>([])

function synchronizeSize(cols: number, rows: number): Promise<void> {
  const session = controller.activeSession.value
  if (disposed || !isConnected.value || !session) return Promise.resolve()
  if (lastSize?.session === session && lastSize.cols === cols && lastSize.rows === rows) {
    return resizeQueue
  }
  lastSize = { session, cols, rows }
  // Serialize controls so a slow earlier size cannot overwrite a newer one.
  const operation = resizeQueue.then(async () => {
    if (disposed || !isConnected.value || controller.activeSession.value !== session) return
    await session.resize(cols, rows)
  }).catch(async () => {
    if (disposed || controller.activeSession.value !== session) return
    discoveryError.value = 'Resize outcome is unconfirmed. It was not resent.'
    await controller.disconnect()
  })
  resizeQueue = operation
  return operation
}

async function refreshTargets() {
  if (!bridge || discovering.value || isConnected.value || isBusy.value) return
  discovering.value = true; discoveryError.value = ''
  try {
    const values = (await bridge.targets()).filter(target => target.providerId === 'org.3mm.terminal'
      && target.capabilityIds.includes('org.3mm.terminal.shell') && target.accessMode === 'write')
    if (disposed) return
    targets.value = values.map(target => ({ id: target.bindingId, label: `${target.bindingId} · ${target.deviceId}`, kind: 'remote' }))
    available.value = values.filter(target => target.available).map(target => target.bindingId)
    if (!targets.value.some(target => target.id === selectedTargetId.value)) selectedTargetId.value = targets.value[0]?.id || ''
  } catch { if (!disposed) { targets.value = []; available.value = []; discoveryError.value = 'Current approved session access is unavailable.' } }
  finally { if (!disposed) discovering.value = false }
}
async function connect() {
  if (!canConnect.value) return
  removeOutput()
  removeExit()
  terminal?.write('\x1b[2J\x1b[H')
  await controller.connect(80, 24)
  const session = controller.activeSession.value
  if (!session || disposed) return
  removeOutput = session.onOutput((data) => {
    terminal?.write(data)
  })
  removeExit = session.onExit(() => {
    void controller.disconnect()
    terminal?.focus()
  })
  // Keep the reviewed opening options unchanged. The current renderer size
  // goes through the separately approved resize control after connection.
  fitAddon?.fit()
  if (terminal) await synchronizeSize(terminal.cols, terminal.rows)
}
async function sendInput() {
  const session = controller.activeSession.value
  if (!session || !isConnected.value || !input.value) return
  const text = input.value
  input.value = ''
  try { await session.write(text + '\r') }
  catch { discoveryError.value = 'Input outcome is unconfirmed. It was not resent.'; await controller.disconnect() }
}

onMounted(() => {
  if (terminalElement.value) {
    terminal = new XTerm({
      cursorBlink: true,
      fontFamily: 'Consolas, monospace',
      fontSize: 14,
      scrollback: 1000,
      theme: {
        background: '#101820',
        foreground: '#d3e0e8',
        cursor: '#ffffff',
      },
    })

    fitAddon = new FitAddon()

    terminal.loadAddon(fitAddon)
    terminal.open(terminalElement.value)
    resizeSubscription = terminal.onResize(({ cols, rows }) => {
      void synchronizeSize(cols, rows)
    })
    fitAddon.fit()
    resizeObserver = new ResizeObserver(() => {
      if (!disposed) fitAddon?.fit()
    })
    resizeObserver.observe(terminalElement.value)

    keyboardSubscription = terminal.onData((data) => {
      if (disposed || !isConnected.value) return

      const session = controller.activeSession.value
      if (!session) return

      // Send exactly once. Never automatically replay
      // terminal input after a transport failure.
      void session.write(data).catch(async () => {
        if (disposed) return

        discoveryError.value =
          'Input outcome is unconfirmed. It was not resent.'

        await controller.disconnect()
      })
    })

  }

  void refreshTargets()
})

onBeforeUnmount(() => {
  disposed = true

  // Stop receiving terminal events.
  removeOutput()
  removeExit()
  resizeObserver?.disconnect()
  resizeObserver = null
  resizeSubscription?.dispose()
  resizeSubscription = null

  // Disconnect the M21 session.
  controller.dispose()

  // Release keyboard subscription.
  keyboardSubscription?.dispose()
  keyboardSubscription = null

  // Release xterm.js and its addons.
  terminal?.dispose()
  terminal = null
  fitAddon = null
})

const statusLabel = computed(() => {
  switch (status.value) {
    case 'connecting':
      return 'Connecting'
    case 'connected':
      return 'Connected'
    case 'disconnecting':
      return 'Disconnecting'
    case 'disconnected':
      return 'Disconnected'
    case 'error':
      return 'Error'
    default:
      return 'Not connected'
  }
})

const canConnect = computed(
  () => controller.canConnect.value && !discovering.value && available.value.includes(selectedTargetId.value),
)
</script>

<template>
  <main class="terminal-page">
    <header class="terminal-header">
      <div>
        <h1>Terminal</h1>
        <p>Interactive system console</p>
      </div>

      <span
        class="terminal-status"
        :data-status="status"
        role="status"
      >
        {{ statusLabel }}
      </span>
    </header>

    <section class="terminal-container">
      <div class="terminal-toolbar">
        <label for="terminal-target">Target</label>

        <select
          id="terminal-target"
          v-model="selectedTargetId"
          :disabled="isBusy || isConnected"
        >
          <option
            v-for="target in targets"
            :key="target.id"
            :value="target.id"
          >
            {{ target.label }}
          </option>
        </select>

        <button type="button" :disabled="!canConnect" @click="connect">
          Connect
        </button>
        <button type="button" :disabled="!isConnected || isBusy" @click="controller.disconnect()">Disconnect</button>
        <button type="button" :disabled="discovering || isConnected || isBusy" @click="refreshTargets">Refresh access</button>
      </div>

      <div class="terminal-screen">
        <div class="terminal-message">
          <p>3mm Terminal v1.0</p>
          <p>Target: {{ selectedTarget?.label ?? 'None' }}</p>
          <p v-if="!isConnected">An approved M20 binding, current user permission and connected provider are required.</p>
          <p>Test sessions use a restricted temporary workspace. Core administration and root access are not enabled.</p>

          <p v-if="discoveryError" class="terminal-error" role="alert">{{ discoveryError }}</p>

          <p v-if="error" class="terminal-error">
            {{ error }}
          </p>
        </div>
        <div
          ref="terminalElement"
          class="terminal-output"
          role="region"
          aria-label="Terminal output"
        ></div>
        <form class="terminal-input" @submit.prevent="sendInput">
          <label for="terminal-input">Session input</label>
          <textarea id="terminal-input" v-model="input" rows="2" :disabled="!isConnected" autocomplete="off" spellcheck="false" maxlength="4096"></textarea>
          <button type="submit" :disabled="!isConnected || !input">Send once</button>
        </form>
      </div>
    </section>
  </main>
</template>

<style src="./vendor/xterm-vendor.css"></style>

<style scoped>
.terminal-page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-height: 400px;
  width: 100%;
}

.terminal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
}

.terminal-header h1 {
  margin: 0;
}

.terminal-header p {
  margin: 0.25rem 0 0;
  opacity: 0.7;
}

.terminal-status {
  font-size: 0.85rem;
  padding: 0.35rem 0.65rem;
  border: 1px solid currentColor;
  border-radius: 6px;
}

.terminal-status[data-status='connected'] {
  color: #46b77b;
}

.terminal-status[data-status='error'] {
  color: #e57373;
}

.terminal-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
  min-height: 350px;
  border: 1px solid var(--border-color, #444);
  border-radius: 8px;
}

.terminal-toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-color, #444);
}

.terminal-toolbar select {
  min-width: 0;
  max-width: 100%;
  padding: 0.4rem;
}

.terminal-toolbar button {
  padding: 0.4rem 0.9rem;
}
.terminal-toolbar button, .terminal-toolbar select, .terminal-input button {
  font: inherit;
  color: var(--ui-text, var(--text-color, #d3e0e8));
  background: var(--ui-surface-alt, var(--card-bg, #202933));
  border: 1px solid var(--ui-border, var(--border-color, #748b9d));
  border-radius: var(--ui-radius-sm, 6px);
  padding: .45rem .75rem;
}
.terminal-toolbar button:disabled, .terminal-input button:disabled { opacity: .5; cursor: default; }

.terminal-screen {
  flex: 1;
  min-height: 300px;
  padding: 1rem;
  background: #101820;
  color: #d3e0e8;
  font-family: monospace;
}

.terminal-message p {
  margin: 0 0 0.5rem;
}

.terminal-error {
  color: #e57373;
}
.terminal-output { width: 100%; height: 420px; min-height: 260px; overflow: hidden; }
.terminal-input { display: grid; gap: .5rem; }
.terminal-input textarea { min-width: 0; width: 100%; color: inherit; background: transparent; font: inherit; }
.terminal-input button { justify-self: start; }
</style>
