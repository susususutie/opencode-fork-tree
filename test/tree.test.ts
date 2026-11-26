import { describe, expect, test } from "bun:test"
import { buildForkTree, scanKey, type ForkSession, type Tombstone } from "../tree"

const session = (id: string, forkFrom?: string, created = 0, title?: string): ForkSession => ({
  id,
  forkFrom,
  created,
  title,
})

const ghost = (id: string, forkFrom: string | undefined, created: number, title?: string): Tombstone => ({
  id,
  forkFrom,
  created,
  title,
  key: "project:p",
  deletedAt: 1,
})

function build(input: {
  sessions: ForkSession[]
  tombstones?: Tombstone[]
  currentID: string
  includeDeleted?: (id: string) => boolean
  labels?: Record<string, { text: string; created?: number }>
}) {
  return buildForkTree({
    sessions: input.sessions,
    tombstones: input.tombstones ?? [],
    currentID: input.currentID,
    includeDeleted: input.includeDeleted ?? (() => false),
    labels: input.labels,
  })
}

describe("buildForkTree", () => {
  test("trunk without forks", () => {
    const tree = build({
      sessions: [session("root", undefined, 1, "main")],
      currentID: "root",
      labels: { root: { text: "first message", created: 10 } },
    })
    expect(tree.count).toBe(0)
    expect(tree.rows.map((row) => [row.id, row.label, row.created])).toEqual([["root", "first message", 10]])
  })

  test("siblings are ordered by creation and keep tree rails", () => {
    const tree = build({
      sessions: [
        session("root", undefined, 1, "main"),
        session("a", "root", 3, "fork #2"),
        session("b", "root", 2, "fork #1"),
      ],
      currentID: "root",
      labels: {
        root: { text: "initial" },
        a: { text: "second branch" },
        b: { text: "first branch" },
      },
    })
    expect(tree.count).toBe(2)
    expect(tree.rows.map((row) => [row.id, row.prefix, row.label])).toEqual([
      ["root", "", "initial"],
      ["b", "├─", "first branch"],
      ["a", "└─", "second branch"],
    ])
  })

  test("nested fork walks to the trunk and marks the current", () => {
    const tree = build({
      sessions: [
        session("root", undefined, 1, "main"),
        session("a", "root", 2, "fork #1"),
        session("b", "a", 3, "fork #2"),
      ],
      currentID: "b",
      labels: { root: { text: "root message" }, a: { text: "branch message" }, b: { text: "nested message" } },
    })
    expect(tree.trunkID).toBe("root")
    expect(tree.rows.map((row) => [row.id, row.prefix, row.isCurrent])).toEqual([
      ["root", "", false],
      ["a", "└─", false],
      ["b", "  └─", true],
    ])
  })

  test("deleted intermediate fork keeps its place with a dashed rail", () => {
    const tree = build({
      sessions: [session("root", undefined, 1, "main"), session("live", "gone", 3, "fork")],
      tombstones: [ghost("gone", "root", 2, "gone")],
      currentID: "root",
      labels: { root: { text: "root" }, live: { text: "live branch" } },
    })
    expect(tree.rows.map((row) => [row.id, row.prefix, row.deleted])).toEqual([
      ["root", "", false],
      ["live", "╎ └╌", false],
    ])
    expect(tree.count).toBe(1)
  })

  test("ephemeral placeholder renders in place and keeps the option list stable", () => {
    const sessions = [session("root", undefined, 1, "main"), session("live", "gone", 3, "fork")]
    const tombstones = [ghost("gone", "root", 2, "gone")]
    const labels = { root: { text: "root" }, gone: { text: "deleted branch" }, live: { text: "live branch" } }
    const before = build({ sessions, tombstones, currentID: "root", includeDeleted: () => true, labels })
    expect(before.rows.map((row) => [row.id, row.deleted, row.glyph, row.label])).toEqual([
      ["root", false, "●", "root"],
      ["gone", true, "○", "deleted branch"],
      ["live", false, "●", "live branch"],
    ])
    const after = build({ sessions, tombstones, currentID: "root", includeDeleted: () => false, labels })
    expect(after.rows.map((row) => row.id)).toEqual(["root", "live"])
  })

  test("deleted trunk leaves its children at depth one with a dashed connector", () => {
    const tree = build({
      sessions: [session("a", "root", 2, "fork")],
      tombstones: [ghost("root", undefined, 1, "main")],
      currentID: "root",
      labels: { root: { text: "deleted root" }, a: { text: "branch" } },
    })
    expect(tree.rows.map((row) => [row.id, row.prefix])).toEqual([["a", "└╌"]])
    expect(tree.count).toBe(1)
  })

  test("missing parent becomes the root of what is known", () => {
    const tree = build({ sessions: [session("a", "missing", 2, "detached")], currentID: "a" })
    expect(tree.trunkID).toBe("a")
    expect(tree.rows.map((row) => row.id)).toEqual(["a"])
  })

  test("scan keys separate projects and directories", () => {
    expect(scanKey({ projectID: "p", location: { directory: "/x" } })).toBe("project:p")
    expect(scanKey({ projectID: "global", location: { directory: "/x" } })).toBe("dir:/x")
  })
})
