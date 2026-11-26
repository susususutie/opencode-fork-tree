// Fork 关系不在 parentID 上：fork 的 parent_id 为 null，真正的来源是 SessionInfo.fork.sessionID。
// 这里只做会话级纯数据转换；详细消息树在 messages.ts。

export type ForkBoundary = { type: "before" | "through"; messageID: string }

export type ForkSession = {
  id: string
  title?: string
  forkFrom?: string
  boundary?: ForkBoundary
  created: number
}

export type Tombstone = ForkSession & {
  /** 扫描缓存的分组键：project:<id> 或 dir:<path> */
  key: string
  deletedAt: number
  /** 侧栏占位符使用的分支标题（删除时冻结） */
  label?: string
  labelCreated?: number
}

export type ForkLabel = {
  text: string
  created?: number
}

export type ForkTreeInput = {
  sessions: readonly ForkSession[]
  tombstones: readonly Tombstone[]
  currentID: string
  /** 删除占位符只在这一轮弹窗里展示；下一次用户打开弹窗时即隐藏 */
  includeDeleted: (id: string) => boolean
  /** 每个会话展示的标题与时间；通常来自该会话第一条自己的 user message */
  labels?: Readonly<Record<string, ForkLabel>>
  fallback?: ForkSession
}

export type ForkRow = {
  id: string
  label: string
  deleted: boolean
  /** 行展示用的时间：优先 labels.created */
  created: number
  isCurrent: boolean
  /** 树形前缀，含连接线；不含节点符号 */
  prefix: string
  glyph: "●" | "○"
}

export type ForkTree = {
  rows: ForkRow[]
  /** 存活 fork 数，不含 trunk */
  count: number
  trunkID?: string
}

type Node = ForkSession & { deleted: boolean }
type Ancestor = { last: boolean; deleted: boolean }

export function scanKey(info: { projectID: string; location: { directory: string } }) {
  return info.projectID === "global" ? `dir:${info.location.directory}` : `project:${info.projectID}`
}

export function buildForkTree(input: ForkTreeInput): ForkTree {
  const byId = new Map<string, Node>()
  for (const session of input.sessions) byId.set(session.id, { ...session, deleted: false })
  // 已删除的数据优先：删除后缓存里可能还留着旧扫描结果，不能让旧数据把占位符顶掉。
  for (const tombstone of input.tombstones) byId.set(tombstone.id, { ...tombstone, deleted: true })
  if (!byId.has(input.currentID) && input.fallback)
    byId.set(input.fallback.id, { ...input.fallback, deleted: false })

  const current = byId.get(input.currentID)
  if (!current) return { rows: [], count: 0 }

  // 沿 fork 来源向上走到 trunk；父节点缺失时停在已知的最高节点。
  const seen = new Set<string>()
  let trunk = current
  while (trunk.forkFrom && !seen.has(trunk.id)) {
    seen.add(trunk.id)
    const parent = byId.get(trunk.forkFrom)
    if (!parent) break
    trunk = parent
  }

  const children = new Map<string, Node[]>()
  for (const node of byId.values()) {
    if (!node.forkFrom) continue
    if (!byId.has(node.forkFrom)) continue
    const list = children.get(node.forkFrom)
    if (list) list.push(node)
    else children.set(node.forkFrom, [node])
  }
  for (const list of children.values()) list.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))

  const all: ForkRow[] = []
  const walk = (node: Node, depth: number, ancestors: Ancestor[], last: boolean, parentDeleted: boolean) => {
    const label = input.labels?.[node.id]
    all.push({
      id: node.id,
      label: label?.text ?? (node.deleted ? "Deleted fork" : "New fork"),
      deleted: node.deleted,
      created: label?.created ?? node.created,
      isCurrent: node.id === input.currentID,
      prefix:
        depth === 0
          ? ""
          : ancestors
              .map((ancestor) => (ancestor.deleted ? "╎ " : ancestor.last ? "  " : "│ "))
              .join("") + (last ? "└" : "├") + (parentDeleted ? "╌" : "─"),
      glyph: node.deleted ? "○" : "●",
    })
    const next = depth === 0 ? [] : [...ancestors, { last, deleted: node.deleted }]
    const list = children.get(node.id) ?? []
    list.forEach((child, index) => walk(child, depth + 1, next, index === list.length - 1, node.deleted))
  }
  walk(trunk, 0, [], true, false)

  const live = all.filter((row) => !row.deleted)
  const count = live.filter((row) => row.id !== trunk.id || trunk.deleted).length
  return {
    rows: all.filter((row) => !row.deleted || input.includeDeleted(row.id)),
    count,
    trunkID: trunk.id,
  }
}
