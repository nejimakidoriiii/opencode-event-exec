export interface EventShape {
  readonly type: string
}

export interface EventExecContext {
  readonly options?: unknown
  readonly event: {
    subscribe(): AsyncIterable<EventShape>
  }
}

export interface ChildProcessHandle {
  on(event: "error", listener: (error: Error) => void): unknown
}

export interface SpawnOptions {
  readonly shell: boolean
  readonly stdio: readonly string[]
}

export type SpawnCommand = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcessHandle

export interface EventExecPlugin {
  readonly id: string
  readonly setup: (context: EventExecContext) => void
}

interface AdoptedRule {
  readonly event: string
  readonly command: string
  readonly args: readonly string[]
}

const PLUGIN_ID = "opencode-event-exec"

export function createEventExecPlugin(config: { readonly spawn: SpawnCommand }): EventExecPlugin {
  return {
    id: PLUGIN_ID,
    setup(context) {
      const rules = adoptRules(context.options)
      void consumeEvents(context, rules, config.spawn).catch(() => undefined)
    },
  }
}

function adoptRules(options: unknown): AdoptedRule[] {
  if (typeof options !== "object" || options === null) return []
  const rules = (options as { readonly rules?: unknown }).rules
  if (!Array.isArray(rules)) return []

  const adopted: AdoptedRule[] = []
  for (const entry of rules as readonly unknown[]) {
    if (typeof entry !== "object" || entry === null) continue
    const candidate = entry as { readonly event?: unknown; readonly command?: unknown; readonly args?: unknown }
    if (typeof candidate.event !== "string" || typeof candidate.command !== "string") continue
    adopted.push({
      event: candidate.event,
      command: candidate.command,
      args: normalizeArgs(candidate.args),
    })
  }
  return adopted
}

function normalizeArgs(args: unknown): readonly string[] {
  if (!Array.isArray(args)) return []
  const normalized: string[] = []
  for (const arg of args as readonly unknown[]) {
    if (typeof arg !== "string") return []
    normalized.push(arg)
  }
  return normalized
}

async function consumeEvents(
  context: EventExecContext,
  rules: readonly AdoptedRule[],
  spawn: SpawnCommand,
): Promise<void> {
  for await (const event of context.event.subscribe()) {
    for (const rule of rules) {
      if (rule.event !== event.type) continue
      startCommand(rule, spawn)
    }
  }
}

function startCommand(rule: AdoptedRule, spawn: SpawnCommand): void {
  try {
    const child = spawn(rule.command, rule.args, { shell: false, stdio: ["ignore", "ignore", "ignore"] })
    child.on("error", (error) => reportSpawnFailure(rule.command, error))
  } catch (error) {
    reportSpawnFailure(rule.command, error)
  }
}

function reportSpawnFailure(command: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error)
  process.stderr.write(
    `${PLUGIN_ID}: failed to spawn ${escapeLineBreaks(command)}: ${escapeLineBreaks(reason)}\n`,
  )
}

function escapeLineBreaks(value: string): string {
  return value.replace(/\r/g, "\\r").replace(/\n/g, "\\n")
}
