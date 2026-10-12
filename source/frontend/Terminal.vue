
<template>
  <main class="terminal-page">
    <header class="terminal-header">
      <div>
        <h1>Terminal</h1>
        <p>3mm Interactive Terminal</p>
      </div>

      <span class="terminal-status">
        Not connected
      </span>
    </header>

    <section class="terminal-container">
      <div class="terminal-toolbar">
        <span>Local Terminal</span>
      </div>

      <div class="terminal-screen">
        <p>3mm Terminal v1.0</p>
        <p>Waiting for M21 Session API...</p>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
// M21 Session SDK integration will be added later.
// No direct shell execution is permitted here.
</script>

<style scoped>
.terminal-page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 100%;
  min-height: 400px;
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
  font-size: 0.8rem;
  opacity: 0.7;
}

.terminal-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
  border: 1px solid var(--border-color, #444);
  border-radius: 8px;
}

.terminal-toolbar {
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-color, #444);
}

.terminal-screen {
  flex: 1;
  min-height: 300px;
  padding: 1rem;
  background: #101820;
  color: #d3e0e8;
  font-family: monospace;
}

.terminal-screen p {
  margin: 0 0 0.5rem;
}
</style>
