declare const process: {
  readonly stderr: {
    write(chunk: string): unknown
  }
}

declare module "node:child_process" {
  export interface ChildProcess {
    on(event: "error", listener: (error: Error) => void): unknown
  }

  export interface SpawnOptions {
    readonly shell?: boolean
    readonly stdio?: "ignore" | readonly string[]
  }

  export function spawn(command: string, args?: readonly string[], options?: SpawnOptions): ChildProcess
}
