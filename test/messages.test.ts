import { describe, expect, test } from "bun:test"
import { buildMessageTree, type BoundaryRecord, type MessageSession, type UserMessage } from "../messages"

const message = (id: string, created: number, text = id): UserMessage => ({ id, created, text })

const trunkMessages = Array.from({ length: 10 }, (_, index) => message(`t${index + 1}`, index + 1))

const trunk: MessageSession = { id: "t", created: 0 }
const forkA: MessageSession = {
  id: "a",
  parentID: "t",
  created: 6,
  boundary: { type: "through", messageID: "idle5" },
}
const forkB: MessageSession = {
  id: "b",
  parentID: "t",
  created: 6,
  boundary: { type: "through", messageID: "idle5" },
}
const nested: MessageSession = {
  id: "c",
  parentID: "a",
  created: 9,
  boundary: { type: "through", messageID: "a1" },
}

const boundaries: Record<string, BoundaryRecord> = {
  idle5: { created: 5, isUser: false },
  a1: { created: 7, isUser: true },
  t9: { created: 9, isUser: true },
}

function input(overrides: Partial<Parameters<typeof buildMessageTree>[0]> = {}) {
  return {
    sessions: [trunk, forkA, forkB, nested],
    messages: {
      t: trunkMessages,
      a: [message("a1", 7), ...trunkMessages.slice(0, 5)],
      b: [message("b1", 8), ...trunkMessages.slice(0, 5)],
      c: [message("c1", 10), ...trunkMessages.slice(0, 5), message("a1", 7)],
    },
    boundaries,
    currentID: "t",
    includeDeleted: () => false,
    ...overrides,
  }
}

const plain = input({ sessions: [trunk, forkA, forkB], messages: { t: trunkMessages, a: [message("a1", 7), ...trunkMessages.slice(0, 5)], b: [message("b1", 8), ...trunkMessages.slice(0, 5)] } })

describe("buildMessageTree", () => {
  test("main line stays flat and forks attach after their boundary", () => {
    const tree = buildMessageTree(plain)
    expect(tree.rows.map((row) => [row.key, row.prefix, row.text])).toEqual([
      ["message:t:t1", "", "t1"],
      ["message:t:t2", "", "t2"],
      ["message:t:t3", "", "t3"],
      ["message:t:t4", "", "t4"],
      ["message:t:t5", "", "t5"],
      ["message:a:a1", "├─", "a1"],
      ["message:b:b1", "├─", "b1"],
      ["message:t:t6", "", "t6"],
      ["message:t:t7", "", "t7"],
      ["message:t:t8", "", "t8"],
      ["message:t:t9", "", "t9"],
      ["message:t:t10", "", "t10"],
    ])
  })

  test("nested fork uses the next lane and the parent rail", () => {
    const tree = buildMessageTree(input({ currentID: "c" }))
    const rows = tree.rows.map((row) => [row.key, row.prefix])
    expect(rows).toContainEqual(["message:c:c1", "│ └─"])
    expect(tree.currentKey).toBe("message:c:c1")
  })

  test("before boundary inserts the branch before the message", () => {
    const before: MessageSession = {
      id: "d",
      parentID: "t",
      created: 11,
      boundary: { type: "before", messageID: "t9" },
    }
    const tree = buildMessageTree(
      input({
        sessions: [trunk, before],
        messages: { t: trunkMessages, d: [message("d1", 12), ...trunkMessages.slice(0, 8)] },
      }),
    )
    const rows = tree.rows.map((row) => [row.key, row.prefix])
    expect(rows).toContainEqual(["message:d:d1", "├─"])
    const branch = tree.rows.findIndex((row) => row.key === "message:d:d1")
    const boundary = tree.rows.findIndex((row) => row.key === "message:t:t9")
    expect(branch).toBeLessThan(boundary)
  })

  test("empty fork gets a branch leaf", () => {
    const empty: MessageSession = {
      id: "e",
      parentID: "t",
      created: 6,
      boundary: { type: "through", messageID: "idle5" },
      label: "No messages yet",
      labelCreated: 11,
    }
    const tree = buildMessageTree(
      input({
        sessions: [trunk, empty],
        messages: { t: trunkMessages },
      }),
    )
    expect(tree.rows.find((row) => row.key === "branch:e")).toMatchObject({
      kind: "branch",
      text: "No messages yet",
      prefix: "├─",
    })
  })

  test("collapse hides long runs between anchors and expands by key", () => {
    const long = Array.from({ length: 20 }, (_, index) => message(`m${index + 1}`, index + 1))
    const fork: MessageSession = {
      id: "f",
      parentID: "t",
      created: 11,
      boundary: { type: "through", messageID: "idle10" },
    }
    const tree = buildMessageTree({
      sessions: [trunk, fork],
      messages: { t: long, f: [message("f1", 12), ...long.slice(0, 10)] },
      boundaries: { idle10: { created: 10, isUser: false } },
      currentID: "t",
      includeDeleted: () => false,
      context: 2,
    })
    const summaries = tree.rows.filter((row) => row.kind === "summary")
    expect(summaries.length).toBeGreaterThan(0)
    expect(summaries[0]?.range).toBeDefined()
    const key = summaries[0]!.range!
    const expanded = new Set([`${key.sessionID}:${key.start}:${key.end}`])
    const more = buildMessageTree({
      sessions: [trunk, fork],
      messages: { t: long, f: [message("f1", 12), ...long.slice(0, 10)] },
      boundaries: { idle10: { created: 10, isUser: false } },
      currentID: "t",
      includeDeleted: () => false,
      context: 2,
      expanded,
    })
    expect(more.rows.some((row) => row.key === summaries[0]!.key)).toBe(false)
  })

  test("deleted branch becomes a ghost leaf and can be hidden", () => {
    const ghost: MessageSession = {
      id: "g",
      parentID: "t",
      created: 6,
      boundary: { type: "through", messageID: "idle5" },
      deleted: true,
      label: "Deleted branch",
      labelCreated: 11,
    }
    const visible = buildMessageTree(
      input({ sessions: [trunk, ghost], messages: { t: trunkMessages }, includeDeleted: () => true }),
    )
    expect(visible.rows.find((row) => row.key === "branch:g")).toMatchObject({
      glyph: "○",
      text: "Deleted branch",
      prefix: "├─",
    })
    const hidden = buildMessageTree(
      input({ sessions: [trunk, ghost], messages: { t: trunkMessages }, includeDeleted: () => false }),
    )
    expect(hidden.rows.some((row) => row.key === "branch:g")).toBe(false)
  })

  test("live child of a deleted branch keeps a dashed lane", () => {
    const ghost: MessageSession = {
      id: "g",
      parentID: "t",
      created: 6,
      boundary: { type: "through", messageID: "idle5" },
      deleted: true,
      label: "Deleted branch",
      labelCreated: 11,
    }
    const child: MessageSession = {
      id: "h",
      parentID: "g",
      created: 8,
      boundary: { type: "through", messageID: "missing" },
    }
    const tree = buildMessageTree(
      input({
        sessions: [trunk, ghost, child],
        messages: { t: trunkMessages, h: [message("h1", 9), ...trunkMessages.slice(0, 5)] },
        includeDeleted: () => false,
      }),
    )
    const row = tree.rows.find((item) => item.key === "message:h:h1")
    expect(row).toBeDefined()
    expect(row?.prefix).toBe("│ └╌")
  })
})
