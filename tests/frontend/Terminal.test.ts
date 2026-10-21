// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { ApplicationSessions } from '@3mm/application-ui/v1'
import type { M21OpenAcceptance, M21OpenRequest } from '../../source/frontend/services/m21TerminalTransport'
import Terminal from '../../source/frontend/Terminal.vue'

interface FakeTerminal {
  cols: number
  rows: number
  data: ((text: string) => void) | null
  resized: ((size: { cols: number; rows: number }) => void) | null
  keyboardDispose: ReturnType<typeof vi.fn>
  resizeDispose: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}

const mock = vi.hoisted(() => ({
  host: vi.fn(),
  terminal: null as FakeTerminal | null,
  fitSize: { cols: 120, rows: 32 },
  fit: vi.fn(),
  observer: null as ResizeObserverCallback | null,
  observe: vi.fn(),
  disconnectObserver: vi.fn(),
}))

vi.mock('@3mm/application-ui/v1', () => ({ useApplicationHost: mock.host }))
vi.mock('../../source/frontend/vendor/xterm-vendor.js', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    data: FakeTerminal['data'] = null
    resized: FakeTerminal['resized'] = null
    keyboardDispose = vi.fn()
    resizeDispose = vi.fn()
    dispose = vi.fn()
    constructor() { mock.terminal = this }
    open() {}
    loadAddon() {}
    write() {}
    focus() {}
    onData(callback: NonNullable<FakeTerminal['data']>) {
      this.data = callback
      return { dispose: this.keyboardDispose }
    }
    onResize(callback: NonNullable<FakeTerminal['resized']>) {
      this.resized = callback
      return { dispose: this.resizeDispose }
    }
  },
  FitAddon: class {
    fit() {
      mock.fit()
      const terminal = mock.terminal!
      if (terminal.cols === mock.fitSize.cols && terminal.rows === mock.fitSize.rows) return
      terminal.cols = mock.fitSize.cols
      terminal.rows = mock.fitSize.rows
      terminal.resized?.(mock.fitSize)
    }
  },
}))

const DEVICE_ID = `dev_${'a'.repeat(32)}`
const SESSION_ID = `ses_${'b'.repeat(32)}`
let wrapper: VueWrapper | null = null
let bridge: ApplicationSessions

beforeEach(() => {
  mock.terminal = null
  mock.fitSize = { cols: 120, rows: 32 }
  mock.observer = null
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { mock.observer = callback }
    observe = mock.observe
    disconnect = mock.disconnectObserver
  })
  const target = {
    bindingId: 'console', deviceId: DEVICE_ID, available: true,
    providerId: 'org.3mm.terminal', capabilityIds: ['org.3mm.terminal.shell'],
    accessMode: 'write' as const, controlActions: ['resize'], options: { cols: 80, rows: 24 },
  }
  bridge = {
    targets: vi.fn(async () => [target]),
    resolveTarget: vi.fn(async () => target),
    open: vi.fn(async (request: M21OpenRequest): Promise<M21OpenAcceptance> => ({
      request_id: request.request_id, session_id: SESSION_ID, state: 'active',
      device_id: request.device_id, provider_id: request.provider_id, capability_id: request.capability_id,
    })),
    observe: vi.fn(() => vi.fn()),
    sendData: vi.fn(async () => {}),
    control: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }
  mock.host.mockReturnValue({ sessions: bridge })
})

afterEach(async () => {
  wrapper?.unmount()
  wrapper = null
  await flushPromises()
  vi.unstubAllGlobals()
})

async function render(connected = true) {
  wrapper = mount(Terminal)
  await flushPromises()
  if (connected) {
    await wrapper.get('.terminal-toolbar button').trigger('click')
    await flushPromises()
  }
  return wrapper
}

function resize(cols: number, rows: number) {
  mock.fitSize = { cols, rows }
  mock.observer?.([], {} as ResizeObserver)
}

describe('Terminal screen with the public M21 host', () => {
  it('opens at reviewed dimensions and synchronizes the fitted renderer using resize', async () => {
    await render()
    expect(bridge.open).toHaveBeenCalledOnce()
    expect(bridge.open).toHaveBeenCalledWith(expect.objectContaining({ options: { cols: 80, rows: 24 } }))
    expect(bridge.control).toHaveBeenCalledOnce()
    expect(bridge.control).toHaveBeenCalledWith(expect.objectContaining({
      session_id: SESSION_ID, action: 'resize', arguments: { cols: 120, rows: 32 },
    }))
    expect(mock.observe).toHaveBeenCalledWith(wrapper!.get('.terminal-output').element)
  })

  it('fits container changes and sends each changed size once, not on unchanged observations', async () => {
    await render()
    resize(100, 28)
    await flushPromises()
    resize(100, 28)
    await flushPromises()
    expect(mock.fit).toHaveBeenCalledTimes(4) // mount, connect, two observations
    expect(bridge.control).toHaveBeenCalledTimes(2)
    expect(bridge.control).toHaveBeenLastCalledWith(expect.objectContaining({ arguments: { cols: 100, rows: 28 } }))
  })

  it('serializes slow resize controls in screen order', async () => {
    await render()
    let release!: () => void
    vi.mocked(bridge.control).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    resize(90, 26)
    await flushPromises()
    resize(110, 30)
    await flushPromises()
    expect(bridge.control).toHaveBeenCalledTimes(2)
    release()
    await flushPromises()
    expect(vi.mocked(bridge.control).mock.calls.map(([control]) => control.arguments)).toEqual([
      { cols: 120, rows: 32 }, { cols: 90, rows: 26 }, { cols: 110, rows: 30 },
    ])
  })

  it('does not send resize controls or keyboard input while disconnected', async () => {
    await render(false)
    resize(100, 28)
    mock.terminal!.data?.('ignored')
    await flushPromises()
    expect(bridge.control).not.toHaveBeenCalled()
    expect(bridge.sendData).not.toHaveBeenCalled()
    expect(bridge.open).not.toHaveBeenCalled()
  })

  it('closes once after an uncertain resize without retrying, reconnecting or sending queued sizes', async () => {
    await render()
    vi.mocked(bridge.control).mockRejectedValueOnce(new Error('Lost resize response'))
    resize(90, 26)
    resize(110, 30)
    await flushPromises()
    resize(130, 40)
    mock.terminal!.data?.('ignored after failure')
    await flushPromises()
    expect(wrapper!.get('[role=alert]').text()).toContain('Resize outcome is unconfirmed')
    expect(bridge.control).toHaveBeenCalledTimes(2)
    expect(bridge.close).toHaveBeenCalledExactlyOnceWith(SESSION_ID)
    expect(bridge.open).toHaveBeenCalledOnce()
    expect(bridge.sendData).not.toHaveBeenCalled()
  })

  it('releases observation and xterm subscriptions and fences queued resize on unmount', async () => {
    await render()
    const terminal = mock.terminal!
    const fitCalls = mock.fit.mock.calls.length
    resize(100, 28) // queued, not yet sent
    wrapper!.unmount()
    wrapper = null
    resize(140, 45) // even an already queued observer callback must do nothing
    terminal.resized?.({ cols: 140, rows: 45 })
    terminal.data?.('ignored after disposal')
    await flushPromises()
    expect(mock.fit).toHaveBeenCalledTimes(fitCalls + 1)
    expect(mock.disconnectObserver).toHaveBeenCalledOnce()
    expect(terminal.resizeDispose).toHaveBeenCalledOnce()
    expect(terminal.keyboardDispose).toHaveBeenCalledOnce()
    expect(terminal.dispose).toHaveBeenCalledOnce()
    expect(bridge.control).toHaveBeenCalledOnce() // initial synchronization only
    expect(bridge.sendData).not.toHaveBeenCalled()
    expect(bridge.close).toHaveBeenCalledExactlyOnceWith(SESSION_ID)
  })
})
