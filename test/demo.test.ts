import { describe, expect, test } from "bun:test"
import { buildDemoTree, renderDemo } from "../dev/demo"

describe("multi-lane demo", () => {
  test("renders four simultaneous lanes, dashed deleted branch and collapsed run", () => {
    const tree = buildDemoTree()
    const text = renderDemo(tree)
    console.log("\n" + text)

    // main + a + a1 + a1a 四条车道同时存在
    expect(text).toContain("│ │ ├─● 区分 401 与 403")
    // 删除分支的子消息用虚线
    expect(text).toContain("└╌")
    // 长主链路中间被折叠
    expect(tree.rows.some((row) => row.kind === "summary")).toBe(true)
    // 当前会话位于最内层子分支
    expect(tree.currentKey).toBe("message:a1a:a1a")
    // 没有自己的消息的 branch（标题沿用会话名）
    expect(tree.rows.some((row) => row.kind === "branch" && row.text === "空分支")).toBe(true)
  })

  test("expanding a summary reveals hidden messages", () => {
    const tree = buildDemoTree()
    const summary = tree.rows.find((row) => row.kind === "summary")
    expect(summary?.range).toBeDefined()
    const range = summary!.range!
    const expanded = new Set([`${range.sessionID}:${range.start}:${range.end}`])
    const more = buildDemoTree(expanded)
    expect(more.rows.some((row) => row.key === summary!.key)).toBe(false)
    expect(more.rows.length).toBeGreaterThan(tree.rows.length)
  })
})
