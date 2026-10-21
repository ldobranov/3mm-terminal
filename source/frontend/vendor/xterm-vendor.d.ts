
export interface Disposable {
  dispose(): void
}

export interface TerminalOptions {
  cursorBlink?: boolean
  fontFamily?: string
  fontSize?: number
  scrollback?: number
  theme?: {
    background?: string
    foreground?: string
    cursor?: string
  }
}

export class Terminal {
  constructor(options?: TerminalOptions)

  readonly cols: number
  readonly rows: number

  open(element: HTMLElement): void
  loadAddon(addon: FitAddon): void
  write(data: string): void
  focus(): void
  dispose(): void

  onData(
    handler: (data: string) => void,
  ): Disposable

  onResize(
    handler: (size: {
      cols: number
      rows: number
    }) => void,
  ): Disposable
}

export class FitAddon {
  fit(): void
  dispose(): void
}
