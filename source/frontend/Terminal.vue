
<script setup lang="ts">
import { computed } from 'vue'
import { useTerminalSession } from './composables/useTerminalSession'

const {
  status,
  error,
  targets,
  selectedTargetId,
  selectedTarget,
  isConnected,
  isBusy,
} = useTerminalSession()

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
  () => false, // Enabled only after M21 integration.
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

        <button type="button" :disabled="!canConnect">
          Connect
        </button>
      </div>

      <div class="terminal-screen">
        <div class="terminal-message">
          <p>3mm Terminal v1.0</p>
          <p>Target: {{ selectedTarget?.label ?? 'None' }}</p>
          <p>Waiting for M21 Interactive Sessions.</p>

          <p v-if="error" class="terminal-error">
            {{ error }}
          </p>
        </div>
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
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-color, #444);
}

.terminal-toolbar select {
  min-width: 150px;
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
</style>
