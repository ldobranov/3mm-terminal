
export interface TerminalSessionOptions {
  targetId: string
  cols: number
  rows: number
}

export type TerminalOutputHandler = (data: string) => void

export type TerminalExitHandler = (
  exitCode: number | null,
) => void

export interface TerminalSession {
  readonly sessionId: string

  write(data: string): Promise<void>

  resize(cols: number, rows: number): Promise<void>

  disconnect(): Promise<void>

  onOutput(handler: TerminalOutputHandler): () => void

  onExit(handler: TerminalExitHandler): () => void
}

export interface TerminalTransport {
  connect(
    options: TerminalSessionOptions,
  ): Promise<TerminalSession>
}
