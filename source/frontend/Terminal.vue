
<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { useApplicationHost } from '@3mm/application-ui/v1'
import { M21TerminalTransport } from './services/m21TerminalTransport'
import { useTerminalSession } from './composables/useTerminalSession'

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
const output = ref('')
const input = ref('')
const discoveryError = ref('')
const discovering = ref(false)
let disposed = false
let removeOutput = () => {}
let removeExit = () => {}
const available = ref<string[]>([])

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
  removeOutput(); removeExit(); output.value = ''
  await controller.connect(80, 24)
  const session = controller.activeSession.value
  if (!session || disposed) return
  removeOutput = session.onOutput(data => { output.value = (output.value + data).slice(-65536) })
  removeExit = session.onExit(() => { void controller.disconnect() })
}
async function sendInput() {
  const session = controller.activeSession.value
  if (!session || !isConnected.value || !input.value) return
  const text = input.value
  input.value = ''
  try { await session.write(text + '\r') }
  catch { discoveryError.value = 'Input outcome is unconfirmed. It was not resent.'; await controller.disconnect() }
}
onMounted(refreshTargets)
onBeforeUnmount(() => { disposed = true; removeOutput(); removeExit(); controller.dispose() })

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
          <p>Plain-text transport preview. Full terminal emulation is not included.</p>

          <p v-if="discoveryError" class="terminal-error" role="alert">{{ discoveryError }}</p>

          <p v-if="error" class="terminal-error">
            {{ error }}
          </p>
        </div>
        <pre class="terminal-output" aria-label="Session output">{{ output }}</pre>
        <form class="terminal-input" @submit.prevent="sendInput">
          <label for="terminal-input">Session input</label>
          <textarea id="terminal-input" v-model="input" rows="2" :disabled="!isConnected" autocomplete="off" spellcheck="false" maxlength="4096"></textarea>
          <button type="submit" :disabled="!isConnected || !input">Send once</button>
        </form>
      </div>
    </section>
  </main>
</template>

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
.terminal-output { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 24rem; overflow: auto; color: inherit; }
.terminal-input { display: grid; gap: .5rem; }
.terminal-input textarea { min-width: 0; width: 100%; color: inherit; background: transparent; font: inherit; }
.terminal-input button { justify-self: start; }
</style>
