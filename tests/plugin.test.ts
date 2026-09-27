import { afterEach, describe, expect, it, vi } from "vitest"
import { createEventExecPlugin } from "../src/plugin.js"

const REGISTERED_EVENT = "session.idle"
const UNREGISTERED_EVENT = "session.text.delta"

type EventShape = { type: string }
type SpawnListener = (...args: unknown[]) => void

type FakeChildProcess = {
  on(event: string, listener: SpawnListener): FakeChildProcess
  emit(event: string, ...args: unknown[]): void
}

type FakeContext = {
  options?: unknown
  event: { subscribe(): AsyncIterable<EventShape> }
}

const openStreams: Array<() => void> = []

function createEventStream() {
  const queue: EventShape[] = []
  let closed = false
  let wake: (() => void) | null = null

  const release = () => {
    const waiting = wake
    wake = null
    waiting?.()
  }

  const iterable: AsyncIterable<EventShape> = {
    [Symbol.asyncIterator](): AsyncIterator<EventShape> {
      return {
        async next(): Promise<IteratorResult<EventShape>> {
          while (queue.length === 0) {
            if (closed) return { done: true, value: undefined }
            await new Promise<void>((resolve) => {
              wake = resolve
            })
          }
          return { done: false, value: queue.shift()! }
        },
      }
    },
  }

  return {
    iterable,
    push: (event: EventShape) => {
      queue.push(event)
      release()
    },
    close: () => {
      closed = true
      release()
    },
  }
}

function createFakeContext(options?: unknown) {
  const stream = createEventStream()
  openStreams.push(stream.close)
  const context: FakeContext = {
    ...(options === undefined ? {} : { options }),
    event: { subscribe: () => stream.iterable },
  }
  return { context, stream }
}

function createFakeSpawn() {
  const processes: FakeChildProcess[] = []
  const spawn = vi.fn((_command: string, _args: readonly string[] | undefined, _options?: unknown) => {
    const listeners = new Map<string, SpawnListener[]>()
    const child: FakeChildProcess = {
      on(event, listener) {
        const registered = listeners.get(event)
        if (registered === undefined) listeners.set(event, [listener])
        else registered.push(listener)
        return child
      },
      emit(event, ...args) {
        const registered = listeners.get(event)
        if (registered === undefined) return
        for (const listener of registered) listener(...args)
      },
    }
    processes.push(child)
    return child
  })
  return { spawn, processes }
}

type FakeSpawn = ReturnType<typeof createFakeSpawn>["spawn"]

async function startPlugin(options?: unknown) {
  const { context, stream } = createFakeContext(options)
  const { spawn, processes } = createFakeSpawn()
  await createEventExecPlugin({ spawn }).setup(context)
  return { stream, spawn, processes }
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (condition()) return
    await Promise.resolve()
  }
  throw new Error(`timed out waiting for ${description}`)
}

async function flushMicrotasks(rounds = 16): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await Promise.resolve()
  }
}

function captureStderr() {
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  return { text: () => write.mock.calls.map((call) => String(call[0])).join("") }
}

function spawnOptions(spawn: FakeSpawn, index: number): Record<string, unknown> {
  const call = spawn.mock.calls.at(index)
  if (call === undefined) throw new Error(`spawn call ${index} was not recorded`)
  const options = call[2]
  if (options === undefined || options === null) return {}
  if (typeof options !== "object") throw new Error("spawn options is not an object")
  return options as Record<string, unknown>
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0)
}

afterEach(() => {
  for (const close of openStreams.splice(0)) close()
  vi.restoreAllMocks()
})

describe("イベントタイプ名の完全一致によるルール発火", () => {
  it("登録済みイベントタイプ名の到着で、ルールの command と args をリテラルのまま1回だけ実行する", async () => {
    const { stream, spawn } = await startPlugin({
      rules: [
        {
          event: REGISTERED_EVENT,
          command: "notify-runner",
          args: ["--title", "session {event}", "plain literal"],
        },
      ],
    })

    stream.push({ type: REGISTERED_EVENT })
    await waitFor(() => spawn.mock.calls.length >= 1, "the matching rule to spawn")

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][0]).toBe("notify-runner")
    expect(spawn.mock.calls[0][1]).toEqual(["--title", "session {event}", "plain literal"])
  })

  it("同一イベントタイプ名に登録した複数ルールを、子プロセスの完了を待たずすべて実行する", async () => {
    const { stream, spawn } = await startPlugin({
      rules: [
        { event: REGISTERED_EVENT, command: "first-command", args: ["first"] },
        { event: REGISTERED_EVENT, command: "second-command", args: ["second"] },
      ],
    })

    stream.push({ type: REGISTERED_EVENT })
    await waitFor(() => spawn.mock.calls.length >= 2, "both matching rules to spawn")

    expect(spawn.mock.calls.map((call) => call[0]).sort()).toEqual(["first-command", "second-command"])
  })

  it("args を省略したルールは引数なしで実行する", async () => {
    const { stream, spawn } = await startPlugin({
      rules: [{ event: REGISTERED_EVENT, command: "notify-runner" }],
    })

    stream.push({ type: REGISTERED_EVENT })
    await waitFor(() => spawn.mock.calls.length >= 1, "the args-less rule to spawn")

    const args = spawn.mock.calls[0][1]
    expect(args === undefined || args.length === 0).toBe(true)
  })
})

describe("未登録・不採用のイベントタイプ名", () => {
  it("未登録のイベントタイプ名ではコマンドを実行せず、stderr にも出力しない", async () => {
    const stderr = captureStderr()
    const { stream, spawn } = await startPlugin({
      rules: [{ event: REGISTERED_EVENT, command: "notify-runner", args: [] }],
    })

    stream.push({ type: UNREGISTERED_EVENT })
    stream.push({ type: REGISTERED_EVENT })
    await waitFor(() => spawn.mock.calls.length >= 1, "the registered rule to spawn")

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][0]).toBe("notify-runner")
    expect(stderr.text()).toBe("")
  })

  const malformedOptions: Array<{ label: string; options: unknown }> = [
    { label: "options がない", options: undefined },
    { label: "rules がない", options: {} },
    { label: "rules が配列でない", options: { rules: "session.idle" } },
    { label: "rules が null", options: { rules: null } },
    { label: "ルールが null", options: { rules: [null] } },
    { label: "ルールが数値", options: { rules: [7] } },
    { label: "event が数値", options: { rules: [{ event: 7, command: "notify-runner", args: [] }] } },
    { label: "command がない", options: { rules: [{ event: REGISTERED_EVENT, args: [] }] } },
    { label: "command が数値", options: { rules: [{ event: REGISTERED_EVENT, command: 7, args: [] }] } },
  ]

  it.each(malformedOptions)(
    "構造不正な設定($label)ではルールを採用せず、警告も出力しない",
    async ({ options }) => {
      const stderr = captureStderr()
      const { stream, spawn } = await startPlugin(options)

      stream.push({ type: REGISTERED_EVENT })
      await flushMicrotasks()

      expect(spawn).not.toHaveBeenCalled()
      expect(stderr.text()).toBe("")
    },
  )

  it("同じイベントタイプ名を持つ有効ルールと不正ルールが混在しても、有効ルールだけを実行する", async () => {
    const { stream, spawn } = await startPlugin({
      rules: [
        { event: REGISTERED_EVENT, command: 7, args: [] },
        { event: REGISTERED_EVENT, command: "valid-command", args: ["ok"] },
      ],
    })

    stream.push({ type: REGISTERED_EVENT })
    await waitFor(() => spawn.mock.calls.length >= 1, "the valid rule to spawn")

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][0]).toBe("valid-command")
    expect(spawn.mock.calls[0][1]).toEqual(["ok"])
  })

  it("timeoutMs などの未知フィールドを持つルールを通常どおり実行する", async () => {
    const { stream, spawn } = await startPlugin({
      rules: [{ event: REGISTERED_EVENT, command: "notify-runner", args: ["x"], timeoutMs: 5000 }],
      timeoutMs: 10000,
    })

    stream.push({ type: REGISTERED_EVENT })
    await waitFor(() => spawn.mock.calls.length >= 1, "the rule with unknown fields to spawn")

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][0]).toBe("notify-runner")
  })
})

describe("コマンド失敗時の本体継続と stderr 出力", () => {
  it("spawn の error が発生しても後続イベントの処理を継続する", async () => {
    const stderr = captureStderr()
    const { stream, spawn, processes } = await startPlugin({
      rules: [{ event: REGISTERED_EVENT, command: "missing-command", args: [] }],
    })

    stream.push({ type: REGISTERED_EVENT })
    await waitFor(() => spawn.mock.calls.length >= 1, "the first event to spawn")
    processes[0].emit("error", new Error("spawn missing-command ENOENT"))

    stream.push({ type: REGISTERED_EVENT })
    await waitFor(() => spawn.mock.calls.length >= 2, "the second event to spawn")

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(nonEmptyLines(stderr.text())).toHaveLength(1)
  })

  it("起動失敗時は stderr に失敗を示す1行だけを出力する", async () => {
    const stderr = captureStderr()
    const { stream, spawn, processes } = await startPlugin({
      rules: [{ event: REGISTERED_EVENT, command: "missing-command", args: ["--flag"] }],
    })

    stream.push({ type: REGISTERED_EVENT })
    await waitFor(() => spawn.mock.calls.length >= 1, "the rule to spawn")
    processes[0].emit("error", new Error("spawn missing-command ENOENT"))

    const lines = nonEmptyLines(stderr.text())
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("missing-command")
    expect(lines[0]).toContain("spawn missing-command ENOENT")
  })

  it("起動失敗時に command へ改行があっても stderr は1物理行で、command は元の値のまま spawn に渡る", async () => {
    const stderr = captureStderr()
    const { stream, spawn, processes } = await startPlugin({
      rules: [{ event: REGISTERED_EVENT, command: "notify\nrunner", args: [] }],
    })

    stream.push({ type: REGISTERED_EVENT })
    await waitFor(() => spawn.mock.calls.length >= 1, "the rule with a line break in command to spawn")
    expect(spawn.mock.calls[0][0]).toBe("notify\nrunner")

    processes[0].emit("error", new Error("ENOENT"))
    await waitFor(() => stderr.text().length > 0, "the spawn failure to be reported")

    const output = stderr.text()
    expect(output.endsWith("\n")).toBe(true)
    expect(output.slice(0, -1)).not.toMatch(/[\r\n]/)
    expect(output).toContain("notify\\nrunner")
    expect(output).toContain("ENOENT")
  })

  it("起動失敗時に失敗理由へ CR/LF があっても stderr は1物理行で、理由の内容が残る", async () => {
    const stderr = captureStderr()
    const { stream, spawn, processes } = await startPlugin({
      rules: [{ event: REGISTERED_EVENT, command: "notify-runner", args: [] }],
    })

    stream.push({ type: REGISTERED_EVENT })
    await waitFor(() => spawn.mock.calls.length >= 1, "the rule to spawn")

    processes[0].emit("error", new Error("first\rsecond\nthird\r\nfourth"))
    await waitFor(() => stderr.text().length > 0, "the spawn failure to be reported")

    const output = stderr.text()
    expect(output.endsWith("\n")).toBe(true)
    expect(output.slice(0, -1)).not.toMatch(/[\r\n]/)
    expect(output).toContain("first\\rsecond\\nthird\\r\\nfourth")
  })

  it("起動に成功したコマンドと非ゼロ終了したコマンドでは stderr に出力せず、後続イベントも継続する", async () => {
    const stderr = captureStderr()
    const { stream, spawn, processes } = await startPlugin({
      rules: [{ event: REGISTERED_EVENT, command: "failing-command", args: [] }],
    })

    stream.push({ type: REGISTERED_EVENT })
    await waitFor(() => spawn.mock.calls.length >= 1, "the first event to spawn")
    expect(stderr.text()).toBe("")

    processes[0].emit("exit", 1, null)
    await flushMicrotasks()
    expect(stderr.text()).toBe("")

    stream.push({ type: REGISTERED_EVENT })
    await waitFor(() => spawn.mock.calls.length >= 2, "the second event to spawn")
    expect(stderr.text()).toBe("")
  })

  it("spawn が同期的に例外を投げても stderr に1行だけ出力し、後続イベントの処理を継続する", async () => {
    const stderr = captureStderr()
    const { context, stream } = createFakeContext({
      rules: [{ event: REGISTERED_EVENT, command: "missing-command", args: [] }],
    })
    const spawn = vi.fn(() => {
      throw new Error("spawn missing-command EINVAL")
    })
    await createEventExecPlugin({ spawn }).setup(context)

    stream.push({ type: REGISTERED_EVENT })
    await waitFor(() => stderr.text().length > 0, "the synchronous spawn failure to be reported")

    stream.push({ type: REGISTERED_EVENT })
    await waitFor(() => spawn.mock.calls.length >= 2, "the event loop to continue after a synchronous spawn failure")

    expect(spawn).toHaveBeenCalledTimes(2)
    const lines = nonEmptyLines(stderr.text())
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("missing-command")
  })
})

describe("コマンドの実行環境", () => {
  it("argv を [command, ...args] として渡し、環境変数と cwd を継承し、標準入力を接続しない", async () => {
    const { stream, spawn } = await startPlugin({
      rules: [{ event: REGISTERED_EVENT, command: "notify-runner", args: ["--flag", "value"] }],
    })

    stream.push({ type: REGISTERED_EVENT })
    await waitFor(() => spawn.mock.calls.length >= 1, "the rule to spawn")

    const [command, args] = spawn.mock.calls[0]
    expect(command).toBe("notify-runner")
    expect(args).toEqual(["--flag", "value"])

    const options = spawnOptions(spawn, 0)
    expect(options.shell).toBeFalsy()
    if (options.env !== undefined) expect(options.env).toEqual(process.env)
    expect(options.cwd === undefined || options.cwd === process.cwd()).toBe(true)

    const stdio = options.stdio
    expect(stdio === "ignore" || (Array.isArray(stdio) && stdio[0] === "ignore")).toBe(true)
  })
})
