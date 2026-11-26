import { describe, expect, test } from "bun:test"
import { formatTime } from "../format"

describe("formatTime", () => {
  test("other days show MM-DD HH:mm", () => {
    const date = new Date(2026, 10, 5, 9, 3)
    expect(formatTime(date.getTime())).toBe("11-05 09:03")
  })

  test("other days keep 24-hour time", () => {
    const date = new Date(2026, 0, 26, 23, 59)
    expect(formatTime(date.getTime())).toBe("01-26 23:59")
  })

  test("today shows only HH:mm", () => {
    const now = new Date()
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 40)
    expect(formatTime(date.getTime())).toBe("10:40")
  })
})
