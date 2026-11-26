import type { ForkBoundary } from "./tree"

// 详细对话树：main line 平铺在 lane 0，fork 在右侧车道；共享的 copied prefix 只显示一次，
// 每个 fork 只展示自己创建之后的 user message。这里只做纯数据转换。

export type UserMessage = {
  id: string
  text: string
  created: number
  files?: readonly unknown[]
  agents?: readonly unknown[]
  skills?: readonly unknown[]
}

export type MessageSession = {
  id: string
  title?: string
  /** fork 来源；trunk 为空 */
  parentID?: string
  created: number
  boundary?: ForkBoundary
  deleted?: boolean
  /** 删除占位符的冻结标题 */
  label?: string
  labelCreated?: number
}

export type BoundaryRecord = {
  created: number
  isUser: boolean
}

export type MessageTreeInput = {
  sessions: readonly MessageSession[]
  messages: Readonly<Record<string, readonly UserMessage[]>>
  /** boundary messageID -> 该消息的时间/类型 */
  boundaries: Readonly<Record<string, BoundaryRecord>>
  currentID: string
  includeDeleted: (id: string) => boolean
  /** 已展开的折叠区间 key */
  expanded?: ReadonlySet<string>
  /** 折叠时每个锚点前后保留的消息数 */
  context?: number
}

export type MessageRow = {
  key: string
  kind: "message" | "branch" | "summary"
  sessionID: string
  messageID?: string
  text: string
  created: number
  lane: number
  prefix: string
  glyph: "●" | "○" | "│"
  deleted: boolean
  current: boolean
  count?: number
  range?: { sessionID: string; start: number; end: number }
}

export type MessageTree = {
  rows: MessageRow[]
  currentKey?: string
}

type Branch = { line: Line }
type Attachments = { before: Branch[]; after: Branch[] }
type Line = {
  session: MessageSession
  lane: number
  parent?: Line
  own: UserMessage[]
  attachments: Map<number, Attachments>
  start: Branch[]
  /** 本行自己的行（消息/摘要/空分支）在扁平行里的下标 */
  ownIndices: number[]
  /** 直接子分支首行在扁平行里的下标；用于判断父链是否还在继续 */
  childFirstIndices: number[]
  firstRow?: number
}

type Planned =
  | { kind: "message"; index: number }
  | { kind: "summary"; start: number; end: number; count: number; created: number }
  | { kind: "empty" }

type PendingRow = {
  row: Omit<MessageRow, "prefix">
  line: Line
  first: boolean
}

const EMPTY: MessageTree = { rows: [] }

function firstLine(text: string) {
  const value = text.replace(/\s+/g, " ").trim()
  return value || "(empty message)"
}

export function compactMessage(text: string) {
  return firstLine(text)
}

export function isDefaultForkTitle(title: string | undefined) {
  return title === undefined || /^.+ \(fork #\d+\)$/.test(title)
}

export function buildMessageTree(input: MessageTreeInput): MessageTree {
  const byId = new Map<string, MessageSession>()
  for (const session of input.sessions) byId.set(session.id, session)

  const current = byId.get(input.currentID)
  if (!current) return EMPTY

  // 从当前会话走回 trunk；消息树只展示这一棵连通树。
  const seen = new Set<string>()
  let trunk = current
  while (trunk.parentID && !seen.has(trunk.id)) {
    seen.add(trunk.id)
    const parent = byId.get(trunk.parentID)
    if (!parent) break
    trunk = parent
  }

  const lines = new Map<string, Line>()
  const makeLine = (session: MessageSession, lane: number, parent?: Line): Line => {
    const source = input.messages[session.id] ?? []
    const own = session.deleted
      ? []
      : session.parentID
        ? source.filter((message) => message.created >= session.created)
        : [...source]
    return {
      session,
      lane,
      parent,
      own,
      attachments: new Map(),
      start: [],
      ownIndices: [],
      childFirstIndices: [],
    }
  }

  const trunkLine = makeLine(trunk, 0)
  lines.set(trunk.id, trunkLine)

  // 先父后子：按创建时间处理 fork，保证父分支的 lane 已分配。
  const forks = input.sessions
    .filter((session) => session.id !== trunk.id)
    .filter((session) => session.parentID !== undefined)
    .toSorted((a, b) => a.created - b.created || a.id.localeCompare(b.id))
  for (const session of forks) {
    const parent = lines.get(session.parentID!)
    if (!parent) continue
    const line = makeLine(session, parent.lane + 1, parent)
    lines.set(session.id, line)
    const attach = attachPoint(parent.own, session, input.boundaries)
    if (attach.index < 0) parent.start.push({ line })
    else {
      const entry = parent.attachments.get(attach.index) ?? { before: [], after: [] }
      entry[attach.after ? "after" : "before"].push({ line })
      parent.attachments.set(attach.index, entry)
    }
  }

  const pending: PendingRow[] = []
  const context = input.context ?? 2
  const expanded = input.expanded ?? new Set<string>()
  let currentKey: string | undefined

  const push = (line: Line, row: Omit<MessageRow, "prefix">, first: boolean) => {
    line.ownIndices.push(pending.length)
    if (first) line.firstRow ??= pending.length
    if (row.current) currentKey = row.key
    pending.push({ row, line, first })
  }

  const renderLine = (line: Line) => {
    if (line.own.length === 0) {
      for (const item of plan(line, context, expanded)) {
        if (item.kind !== "empty") continue
        const current = line.session.id === input.currentID
        push(
          line,
          {
            key: `branch:${line.session.id}`,
            kind: "branch",
            sessionID: line.session.id,
            text:
              line.session.label ??
              (line.session.deleted
                ? "Deleted fork"
                : isDefaultForkTitle(line.session.title)
                  ? "New fork"
                  : line.session.title!),
            created: line.session.labelCreated ?? line.session.created,
            lane: line.lane,
            glyph: line.session.deleted ? "○" : "●",
            deleted: line.session.deleted === true,
            current,
          },
          true,
        )
      }
      for (const branch of line.start) renderLine(branch.line)
      return
    }
    const visible = plan(line, context, expanded)
    for (const branch of line.start) renderLine(branch.line)
    for (const item of visible) {
      if (item.kind === "summary") {
        const key = `summary:${line.session.id}:${item.start}:${item.end}`
        push(
          line,
          {
            key,
            kind: "summary",
            sessionID: line.session.id,
            text: `… ${item.count} user messages`,
            created: item.created,
            lane: line.lane,
            glyph: "│",
            deleted: line.session.deleted === true,
            current: false,
            count: item.count,
            range: { sessionID: line.session.id, start: item.start, end: item.end },
          },
          line.ownIndices.length === 0,
        )
        continue
      }
      if (item.kind === "empty") continue
      const message = line.own[item.index]
      const attachments = line.attachments.get(item.index)
      for (const branch of attachments?.before ?? []) renderLine(branch.line)
      const current = line.session.id === input.currentID && item.index === lastOwnIndex(line, input.currentID)
      push(
        line,
        {
          key: `message:${line.session.id}:${message.id}`,
          kind: "message",
          sessionID: line.session.id,
          messageID: message.id,
          text: firstLine(message.text),
          created: message.created,
          lane: line.lane,
          glyph: "●",
          deleted: false,
          current,
        },
        line.ownIndices.length === 0,
      )
      for (const branch of attachments?.after ?? []) renderLine(branch.line)
    }
  }

  renderLine(trunkLine)

  // 计算每个直接子分支的首行下标，供父链 continuation 判断。
  for (let index = 0; index < pending.length; index++) {
    const item = pending[index]
    if (item.first) item.line.parent?.childFirstIndices.push(index)
  }

  const rows: MessageRow[] = []
  for (let index = 0; index < pending.length; index++) {
    const item = pending[index]
    const line = item.line
    const lane = line.lane
    const segments: string[] = []
    let ancestor: Line | undefined = line.parent
    for (let currentLane = lane - 1; currentLane >= 0; currentLane--) {
      if (!ancestor) {
        segments.unshift("  ")
        continue
      }
      const continuation = [...ancestor.ownIndices, ...ancestor.childFirstIndices].some((value) => value > index)
      if (currentLane === lane - 1) {
        if (item.first) {
          segments.unshift((continuation ? "├" : "└") + (ancestor.session.deleted ? "╌" : "─"))
        } else {
          segments.unshift(ancestor.session.deleted ? "╎ " : continuation ? "│ " : "  ")
        }
      } else {
        segments.unshift(ancestor.session.deleted ? "╎ " : continuation ? "│ " : "  ")
      }
      ancestor = ancestor.parent
    }
    rows.push({ ...item.row, prefix: segments.join("") })
  }

  const hidden = (id: string) => {
    const line = lines.get(id)
    return line?.session.deleted === true && !input.includeDeleted(id)
  }
  return {
    rows: rows.filter((row) => !hidden(row.sessionID) || row.kind === "summary" || row.key === currentKey),
    currentKey,
  }
}

function lastOwnIndex(line: Line, currentID: string) {
  if (line.session.id !== currentID || line.own.length === 0) return -1
  return line.own.length - 1
}

function attachPoint(
  own: readonly UserMessage[],
  session: MessageSession,
  boundaries: Readonly<Record<string, BoundaryRecord>>,
) {
  const boundary = session.boundary
  if (!boundary) return { index: own.length ? own.length - 1 : -1, after: true }
  const exact = own.findIndex((message) => message.id === boundary.messageID)
  if (boundary.type === "before" && exact >= 0) return { index: exact, after: false }
  const record = boundaries[boundary.messageID]
  const time = record?.created ?? session.created
  if (boundary.type === "before") {
    const next = own.findIndex((message) => message.created >= time)
    return { index: next >= 0 ? next : own.length - 1, after: next < 0 && own.length > 0 }
  }
  if (exact >= 0) return { index: exact, after: true }
  let last = -1
  for (let index = 0; index < own.length; index++) if (own[index].created <= time) last = index
  if (last >= 0) return { index: last, after: true }
  // boundary 在父会话的 copied prefix 里：落到父分支的第一条自己的消息之后。
  return own.length > 0 ? { index: 0, after: true } : { index: -1, after: true }
}

function plan(line: Line, context: number, expanded: ReadonlySet<string>): Planned[] {
  if (line.own.length === 0) return [{ kind: "empty" }]
  const anchors = new Set<number>([0, line.own.length - 1])
  for (const index of line.attachments.keys()) anchors.add(index)
  const visible = new Set<number>()
  for (const anchor of anchors) {
    for (let index = Math.max(0, anchor - context); index <= Math.min(line.own.length - 1, anchor + context); index++)
      visible.add(index)
  }
  const result: Planned[] = []
  let index = 0
  while (index < line.own.length) {
    if (visible.has(index)) {
      result.push({ kind: "message", index })
      index++
      continue
    }
    let end = index
    while (end + 1 < line.own.length && !visible.has(end + 1)) end++
    const key = `${line.session.id}:${index}:${end}`
    if (expanded.has(key)) {
      for (let next = index; next <= end; next++) result.push({ kind: "message", index: next })
    } else {
      result.push({ kind: "summary", start: index, end, count: end - index + 1, created: line.own[index].created })
    }
    index = end + 1
  }
  return result
}
