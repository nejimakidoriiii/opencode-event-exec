import { afterEach, describe, expect, it, vi } from "vitest"
import { createEventExecPlugin, substitutePlaceholders } from "../src/plugin.js"

const REGISTERED_EVENT = "session.idle"
const UNREGISTERED_EVENT = "session.text.delta"

type EventShape = {
  type: string
  created?: unknown
  data?: unknown
}
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

describe("プレースホルダー置換の純関数", () => {
  it("{event} をイベントタイプ名へ置換する", () => {
    expect(substitutePlaceholders("{event}", { type: "session.idle" })).toBe("session.idle")
  })

  it("{sessionID} を data.sessionID が文字列のときだけ置換する", () => {
    expect(
      substitutePlaceholders("{sessionID}", { type: "session.created", data: { sessionID: "ses_abc123" } }),
    ).toBe("ses_abc123")
  })

  it("{agent} を data.agent が文字列のときだけ置換する", () => {
    expect(substitutePlaceholders("{agent}", { type: "session.created", data: { agent: "claude" } })).toBe(
      "claude",
    )
  })

  it("{model} を data.model が文字列のときだけ置換する", () => {
    expect(substitutePlaceholders("{model}", { type: "session.created", data: { model: "glm" } })).toBe("glm")
  })

  it("{created} をトップレベル created の数値文字列へ置換する", () => {
    expect(substitutePlaceholders("{created}", { type: "session.created", created: 1758940800000 })).toBe(
      "1758940800000",
    )
  })

  it("{data} を data 全体の compact JSON 1 引数へ置換する", () => {
    expect(
      substitutePlaceholders("{data}", {
        type: "session.created",
        data: { sessionID: "ses_abc123", agent: "claude", model: "glm" },
      }),
    ).toBe('{"sessionID":"ses_abc123","agent":"claude","model":"glm"}')
  })

  it("{data} は配列も compact JSON へ置換する", () => {
    expect(substitutePlaceholders("{data}", { type: "custom.array", data: [1, 2] })).toBe("[1,2]")
  })

  it("data が null のとき {data} はリテラルのまま残す", () => {
    expect(substitutePlaceholders("{data}", { type: "custom.null", data: null })).toBe("{data}")
  })

  it("data が object でないとき {data} はリテラルのまま残す", () => {
    expect(substitutePlaceholders("{data}", { type: "custom.text", data: "payload" })).toBe("{data}")
  })

  it("data を省略したとき {data} はリテラルのまま残す", () => {
    expect(substitutePlaceholders("{data}", { type: "session.created" })).toBe("{data}")
  })

  it("参照先が欠落したプレースホルダーはリテラルのまま残す", () => {
    expect(substitutePlaceholders("{agent}", { type: "session.idle" })).toBe("{agent}")
    expect(substitutePlaceholders("{sessionID}", { type: "session.idle" })).toBe("{sessionID}")
    expect(substitutePlaceholders("{created}", { type: "session.idle" })).toBe("{created}")
  })

  it("参照先の型が一致しないプレースホルダーはリテラルのまま残す", () => {
    expect(substitutePlaceholders("{sessionID}", { type: "custom", data: { sessionID: 7 } })).toBe("{sessionID}")
    expect(substitutePlaceholders("{agent}", { type: "custom", data: { agent: 7 } })).toBe("{agent}")
    expect(substitutePlaceholders("{model}", { type: "custom", data: { model: 7 } })).toBe("{model}")
    expect(substitutePlaceholders("{created}", { type: "custom", created: "1758940800000" })).toBe("{created}")
  })

  it("未知のプレースホルダー名は検証せずリテラルのまま残す", () => {
    expect(
      substitutePlaceholders("{turn}", { type: "session.created", data: { sessionID: "ses_abc123" } }),
    ).toBe("{turn}")
  })

  it("空白入りのプレースホルダー名は未成名としてリテラルのまま残す", () => {
    expect(substitutePlaceholders("{ event }", { type: "session.created" })).toBe("{ event }")
  })

  it("引数に埋め込まれたプレースホルダーも置換する", () => {
    expect(substitutePlaceholders("session {event} ended", { type: "session.created" })).toBe(
      "session session.created ended",
    )
  })

  it("同一引数内の複数出現を置換する", () => {
    expect(
      substitutePlaceholders("{event}-{created}", { type: "session.created", created: 1758940800000 }),
    ).toBe("session.created-1758940800000")
  })

  it("同一プレースホルダーの重複出現を両方置換する", () => {
    expect(substitutePlaceholders("{event}{event}", { type: "session.idle" })).toBe("session.idlesession.idle")
  })

  it("{{event}} は内側の {event} だけを置換し外側の波括弧を残す", () => {
    expect(substitutePlaceholders("{{event}}", { type: "session.created" })).toBe("{session.created}")
  })

  it("置換結果に偶然含まれるプレースホルダーは再置換しない", () => {
    expect(substitutePlaceholders("{sessionID}", { type: "custom", data: { sessionID: "{event}" } })).toBe(
      "{event}",
    )
    expect(substitutePlaceholders("{data}", { type: "custom", data: { note: "{event}" } })).toBe(
      '{"note":"{event}"}',
    )
  })

  it("プレースホルダーを含まない引数はそのまま返す", () => {
    expect(substitutePlaceholders("plain literal", { type: "session.idle" })).toBe("plain literal")
    expect(substitutePlaceholders("", { type: "session.idle" })).toBe("")
  })
})

describe("イベントタイプ名の完全一致によるルール発火", () => {
  it("登録済みイベントタイプ名の到着で、プレースホルダーを含まない args はそのまま、{event} はイベントタイプ名へ置換して1回だけ実行する", async () => {
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
    expect(spawn.mock.calls[0][1]).toEqual(["--title", "session session.idle", "plain literal"])
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

describe("イベントから spawn argv へのプレースホルダー置換", () => {
  it("{event} と {sessionID} を実フィールド値へ置換して argv に渡す", async () => {
    const { stream, spawn } = await startPlugin({
      rules: [{ event: "session.created", command: "notify-runner", args: ["{event}", "{sessionID}"] }],
    })

    stream.push({ type: "session.created", data: { sessionID: "ses_abc123" } })
    await waitFor(() => spawn.mock.calls.length >= 1, "the rule to spawn")

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][0]).toBe("notify-runner")
    expect(spawn.mock.calls[0][1]).toEqual(["session.created", "ses_abc123"])
  })

  it("{created} をエポックミリ秒の数値文字列として argv に渡す", async () => {
    const { stream, spawn } = await startPlugin({
      rules: [{ event: "session.created", command: "notify-runner", args: ["{created}"] }],
    })

    stream.push({ type: "session.created", created: 1758940800000 })
    await waitFor(() => spawn.mock.calls.length >= 1, "the rule to spawn")

    expect(spawn.mock.calls[0][1]).toEqual(["1758940800000"])
  })

  it("{data} を compact JSON 文字列 1 引数として argv に渡す", async () => {
    const { stream, spawn } = await startPlugin({
      rules: [{ event: "session.created", command: "notify-runner", args: ["{data}"] }],
    })

    stream.push({ type: "session.created", data: { sessionID: "ses_abc123", agent: "claude", model: "glm" } })
    await waitFor(() => spawn.mock.calls.length >= 1, "the rule to spawn")

    expect(spawn.mock.calls[0][1]).toEqual(['{"sessionID":"ses_abc123","agent":"claude","model":"glm"}'])
  })

  it("data を省略したイベントでは {data} をリテラルのまま argv に渡す", async () => {
    const { stream, spawn } = await startPlugin({
      rules: [{ event: "session.created", command: "notify-runner", args: ["{data}"] }],
    })

    stream.push({ type: "session.created" })
    await waitFor(() => spawn.mock.calls.length >= 1, "the rule to spawn")

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][1]).toEqual(["{data}"])
  })

  it("埋め込み・複数出現・重複出現のプレースホルダーを argv へ置換する", async () => {
    const { stream, spawn } = await startPlugin({
      rules: [
        {
          event: "session.created",
          command: "notify-runner",
          args: ["session {event} ended", "{event}-{created}", "{event}{event}"],
        },
      ],
    })

    stream.push({ type: "session.created", created: 1758940800000 })
    await waitFor(() => spawn.mock.calls.length >= 1, "the rule to spawn")

    expect(spawn.mock.calls[0][1]).toEqual([
      "session session.created ended",
      "session.created-1758940800000",
      "session.createdsession.created",
    ])
  })

  it("置換結果に偶然含まれるプレースホルダー文字列は再置換せず argv に渡す", async () => {
    const { stream, spawn } = await startPlugin({
      rules: [{ event: "session.created", command: "notify-runner", args: ["{data}"] }],
    })

    stream.push({ type: "session.created", data: { note: "{event}" } })
    await waitFor(() => spawn.mock.calls.length >= 1, "the rule to spawn")

    expect(spawn.mock.calls[0][1]).toEqual(['{"note":"{event}"}'])
  })

  it("{{event}} は内側だけを置換した argv を渡す", async () => {
    const { stream, spawn } = await startPlugin({
      rules: [{ event: "session.created", command: "notify-runner", args: ["{{event}}"] }],
    })

    stream.push({ type: "session.created" })
    await waitFor(() => spawn.mock.calls.length >= 1, "the rule to spawn")

    expect(spawn.mock.calls[0][1]).toEqual(["{session.created}"])
  })

  const unresolvedArgs: Array<{ label: string; event: EventShape; arg: string }> = [
    { label: "data に agent がない", event: { type: "session.idle" }, arg: "{agent}" },
    { label: "data に model がない", event: { type: "session.idle" }, arg: "{model}" },
    {
      label: "data.sessionID が文字列型でない",
      event: { type: "session.idle", data: { sessionID: 7 } },
      arg: "{sessionID}",
    },
    {
      label: "トップレベルの created が数値型でない",
      event: { type: "session.idle", created: "1758940800000" },
      arg: "{created}",
    },
    { label: "data が null", event: { type: "session.idle", data: null }, arg: "{data}" },
    {
      label: "未知の名前",
      event: { type: "session.created", data: { sessionID: "ses_abc123" } },
      arg: "{turn}",
    },
    {
      label: "空白入りの名前",
      event: { type: "session.created", data: { sessionID: "ses_abc123" } },
      arg: "{ event }",
    },
  ]

  it.each(unresolvedArgs)(
    "解決できないプレースホルダー($label)はリテラルのまま argv に渡す",
    async ({ event, arg }) => {
      const { stream, spawn } = await startPlugin({
        rules: [{ event: event.type, command: "notify-runner", args: [arg] }],
      })

      stream.push(event)
      await waitFor(() => spawn.mock.calls.length >= 1, "the rule to spawn")

      expect(spawn.mock.calls[0][1]).toEqual([arg])
    },
  )

  it("command は登録した文字列のまま起動し、置換は args の各要素だけに適用する", async () => {
    const { stream, spawn } = await startPlugin({
      rules: [{ event: "session.created", command: "{event}-runner", args: ["{event}"] }],
    })

    stream.push({ type: "session.created" })
    await waitFor(() => spawn.mock.calls.length >= 1, "the rule to spawn")

    expect(spawn.mock.calls[0][0]).toBe("{event}-runner")
    expect(spawn.mock.calls[0][1]).toEqual(["session.created"])
  })

  it("同じルールが複数イベントで発火したとき、各イベントのフィールド値で毎回置換する", async () => {
    const { stream, spawn } = await startPlugin({
      rules: [{ event: "session.created", command: "notify-runner", args: ["{data}"] }],
    })

    stream.push({ type: "session.created", data: { sessionID: "ses_first" } })
    await waitFor(() => spawn.mock.calls.length >= 1, "the first event to spawn")

    stream.push({ type: "session.created", data: { sessionID: "ses_second" } })
    await waitFor(() => spawn.mock.calls.length >= 2, "the second event to spawn")

    expect(spawn.mock.calls[0][1]).toEqual(['{"sessionID":"ses_first"}'])
    expect(spawn.mock.calls[1][1]).toEqual(['{"sessionID":"ses_second"}'])
  })
})
