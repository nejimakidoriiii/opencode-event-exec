import { describe, expect, it } from "vitest"
import plugin from "../src/index.js"

describe("公開エントリの default export", () => {
  it("promise 型プラグイン({ id, setup })を提供する", () => {
    expect(plugin).toBeTypeOf("object")
    expect(plugin).not.toBeNull()
    expect(plugin.id).toBeTypeOf("string")
    expect(plugin.setup).toBeTypeOf("function")
  })
})
