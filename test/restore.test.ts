import { describe, expect, test } from "bun:test"
import { measureEditText } from "@opentui/core"
import { mentionsToCells, projectedPromptInput } from "../restore"

describe("restore prompt input", () => {
  test("projects files, agents and skills without importing host internals", () => {
    const prompt = projectedPromptInput({
      id: "m",
      created: 1,
      text: "hello",
      files: [
        { uri: "data:text/plain;base64,eA==", name: "a.txt" },
        { source: { type: "uri", uri: "file:///tmp/x" }, name: "x" },
      ],
      agents: [{ name: "build", mention: { start: 0, end: 5, text: "hello" } }],
      skills: [{ id: "skill", mention: { start: 0, end: 5, text: "hello" } }],
    })
    expect(prompt.files?.[0]?.uri).toBe("data:text/plain;base64,eA==")
    expect(prompt.files?.[1]?.uri).toBe("file:///tmp/x")
    expect(prompt.agents?.[0]?.name).toBe("build")
    expect(prompt.skills?.[0]?.id).toBe("skill")
  })

  test("converts char offsets to display cells like the host", () => {
    const text = "你好 @agent hi"
    const start = text.indexOf("@agent")
    const end = start + "@agent".length
    const cellStart = measureEditText(text.slice(0, start), { widthMethod: "unicode" })
    const cellEnd = measureEditText(text.slice(0, end), { widthMethod: "unicode" })
    const converted = mentionsToCells(
      {
        text,
        agents: [{ name: "agent", mention: { start, end, text: "@agent" } }],
      },
      "unicode",
    )
    expect(converted.agents?.[0]?.mention).toEqual({ start: cellStart, end: cellEnd, text: "@agent" })
  })
})
