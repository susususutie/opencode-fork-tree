/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, For, on, Show, untrack } from "solid-js"
import {
  buildForkTree,
  scanKey,
  type ForkLabel,
  type ForkRow,
  type ForkSession,
  type ForkTree,
  type Tombstone,
} from "./tree"
import {
  buildMessageTree,
  compactMessage,
  isDefaultForkTitle,
  type BoundaryRecord,
  type MessageRow,
  type MessageSession,
  type UserMessage,
} from "./messages"
import { forkFromMessage } from "./restore"
import { formatTime } from "./format"

type SessionInfo = NonNullable<ReturnType<Plugin.Context["data"]["session"]["get"]>>

type ScanEntry = {
  status: "loading" | "ready" | "error"
  sessions: ForkSession[]
  token: string
  error?: string
}

type ScanState = {
  generation: number
  projects: Record<string, ScanEntry>
}

type MessageEntry = {
  status: "loading" | "ready" | "error"
  messages: UserMessage[]
  token: string
  error?: string
}

type MessageState = {
  entries: Record<string, MessageEntry>
}

type BoundaryEntry = {
  status: "loading" | "ready" | "error"
  record?: BoundaryRecord
  token: string
}

type BoundaryState = {
  entries: Record<string, BoundaryEntry>
}

type DeletedState = {
  entries: Record<string, Tombstone>
}

type EphemeralState = {
  ids: string[]
}

const emptyTree: ForkTree = { rows: [], count: 0 }
const MEDIA_CAPABILITY = { headers: { "X-OpenCode-Capabilities": "experimental-media-uri" } }

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isTombstone(session: ForkSession | Tombstone): session is Tombstone {
  return "deletedAt" in session
}

export default Plugin.define({
  id: "fork-tree",
  setup(context) {
    const [scan, setScan] = context.storage.memory<ScanState>("scan", { initial: { generation: 0, projects: {} } })
    const [messages, setMessages] = context.storage.memory<MessageState>("messages", { initial: { entries: {} } })
    const [boundaries, setBoundaries] = context.storage.memory<BoundaryState>("boundaries", {
      initial: { entries: {} },
    })
    const [deleted, setDeleted] = context.storage.store<DeletedState>("deleted", { initial: { entries: {} } })
    const [ephemeral, setEphemeral] = context.storage.memory<EphemeralState>("ephemeral", { initial: { ids: [] } })
    const expanded = new Set<string>()
    const pendingScans = new Map<string, { token: string; promise: Promise<void> }>()
    const pendingMessages = new Map<string, { token: string; promise: Promise<void> }>()
    const pendingBoundaries = new Map<string, { token: string; promise: Promise<void> }>()
    let sequence = 0

    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
      context.ui.toast.show({ message, variant, duration: 4000 })

    function mapSession(info: SessionInfo): ForkSession {
      return {
        id: info.id,
        title: info.title,
        forkFrom: info.fork?.sessionID,
        boundary: info.fork?.boundary,
        created: info.time.created,
      }
    }

    async function fetchSessions(info: SessionInfo) {
      const collected: ForkSession[] = []
      let cursor: string | undefined
      for (let page = 0; page < 20; page++) {
        const response = await context.client.session.list({
          ...(info.projectID === "global" ? { directory: info.location.directory } : { project: info.projectID }),
          parentID: null,
          archived: false,
          order: "desc",
          limit: 200,
          ...(cursor ? { cursor } : {}),
        })
        for (const session of response.data) collected.push(mapSession(session))
        cursor = response.cursor.next ?? undefined
        if (!cursor) return collected
      }
      return collected
    }

    function ensureScan(key: string, info: SessionInfo) {
      const entry = scan.projects[key]
      if (entry?.status === "ready") return Promise.resolve()
      const inFlight = pendingScans.get(key)
      if (inFlight && entry?.status === "loading" && entry.token === inFlight.token) return inFlight.promise
      const token = `${Date.now()}:${++sequence}`
      setScan((draft) => {
        draft.projects[key] = { status: "loading", sessions: entry?.sessions ?? [], token }
      })
      const promise = fetchSessions(info)
        .then((sessions) => {
          setScan((draft) => {
            const current = draft.projects[key]
            if (!current || current.token !== token) return
            draft.projects[key] = { status: "ready", sessions, token }
          })
        })
        .catch((error) => {
          setScan((draft) => {
            const current = draft.projects[key]
            if (!current || current.token !== token) return
            draft.projects[key] = { ...current, status: "error", error: messageOf(error) }
          })
          throw error
        })
        .finally(() => {
          if (pendingScans.get(key)?.token === token) pendingScans.delete(key)
        })
      pendingScans.set(key, { token, promise })
      return promise
    }

    function invalidateScan() {
      setScan((draft) => {
        for (const [key, entry] of Object.entries(draft.projects)) {
          draft.projects[key] = { ...entry, status: "loading", token: "", error: undefined }
        }
        draft.generation += 1
      })
    }

    async function fetchMessages(sessionID: string) {
      const collected: UserMessage[] = []
      let cursor: string | undefined
      for (let page = 0; page < 20; page++) {
        const response = await context.client.message.list(
          page === 0
            ? { sessionID, type: "user", order: "asc", limit: 200 }
            : { sessionID, limit: 200, cursor: cursor! },
          MEDIA_CAPABILITY,
        )
        for (const item of response.data) {
          if (item.type !== "user") continue
          collected.push({
            id: item.id,
            text: item.text,
            created: item.time.created,
            files: item.files,
            agents: item.agents,
            skills: item.skills,
          })
        }
        cursor = response.cursor.next ?? undefined
        if (!cursor) return collected
      }
      return collected
    }

    function ensureMessage(sessionID: string) {
      const entry = messages.entries[sessionID]
      if (entry?.status === "ready") return Promise.resolve()
      const inFlight = pendingMessages.get(sessionID)
      if (inFlight && entry?.status === "loading" && entry.token === inFlight.token) return inFlight.promise
      const token = `${Date.now()}:${++sequence}`
      setMessages((draft) => {
        draft.entries[sessionID] = { status: "loading", messages: entry?.messages ?? [], token }
      })
      const promise = fetchMessages(sessionID)
        .then((list) => {
          setMessages((draft) => {
            const current = draft.entries[sessionID]
            if (!current || current.token !== token) return
            draft.entries[sessionID] = { status: "ready", messages: list, token }
          })
        })
        .catch((error) => {
          setMessages((draft) => {
            const current = draft.entries[sessionID]
            if (!current || current.token !== token) return
            draft.entries[sessionID] = { ...current, status: "error", error: messageOf(error) }
          })
          throw error
        })
        .finally(() => {
          if (pendingMessages.get(sessionID)?.token === token) pendingMessages.delete(sessionID)
        })
      pendingMessages.set(sessionID, { token, promise })
      return promise
    }

    function ensureMessages(ids: readonly string[]) {
      return Promise.all([...new Set(ids)].map((id) => ensureMessage(id)))
    }

    function invalidateMessages(sessionID: string) {
      setMessages((draft) => {
        delete draft.entries[sessionID]
      })
    }

    function ensureBoundary(session: ForkSession) {
      const boundary = session.boundary
      const parentID = session.forkFrom
      if (!boundary || !parentID) return Promise.resolve()
      const id = boundary.messageID
      const entry = boundaries.entries[id]
      if (entry?.status === "ready") return Promise.resolve()
      const inFlight = pendingBoundaries.get(id)
      if (inFlight && entry?.status === "loading" && entry.token === inFlight.token) return inFlight.promise
      const token = `${Date.now()}:${++sequence}`
      setBoundaries((draft) => {
        draft.entries[id] = { status: "loading", token }
      })
      const promise = context.client.session.message
        .get({ sessionID: parentID, messageID: id }, MEDIA_CAPABILITY)
        .then((message) => {
          setBoundaries((draft) => {
            const current = draft.entries[id]
            if (!current || current.token !== token) return
            draft.entries[id] = {
              status: "ready",
              token,
              record: { created: message.time.created, isUser: message.type === "user" },
            }
          })
        })
        .catch(() => {
          setBoundaries((draft) => {
            const current = draft.entries[id]
            if (!current || current.token !== token) return
            draft.entries[id] = { status: "error", token }
          })
        })
        .finally(() => {
          if (pendingBoundaries.get(id)?.token === token) pendingBoundaries.delete(id)
        })
      pendingBoundaries.set(id, { token, promise })
      return promise
    }

    function ensureBoundaries(sessions: readonly ForkSession[]) {
      return Promise.all(sessions.filter((session) => session.boundary && session.forkFrom).map(ensureBoundary))
    }

    function resolveCurrent(sessionID: string) {
      const root = context.data.session.root(sessionID)
      const info = context.data.session.get(root) ?? context.data.session.get(sessionID)
      return { currentID: info?.id ?? root, info }
    }

    function resolveTrunkID(sessions: readonly ForkSession[], tombstones: readonly Tombstone[], currentID: string) {
      const byId = new Map<string, ForkSession | Tombstone>(
        [...sessions, ...tombstones].map((session) => [session.id, session]),
      )
      let current = byId.get(currentID)
      const seen = new Set<string>()
      while (current?.forkFrom && !seen.has(current.id)) {
        seen.add(current.id)
        const parent = byId.get(current.forkFrom)
        if (!parent) break
        current = parent
      }
      return current?.id ?? currentID
    }

    function componentSessions(
      sessions: readonly ForkSession[],
      tombstones: readonly Tombstone[],
      trunkID: string,
    ) {
      const all = [...sessions, ...tombstones]
      const byId = new Map<string, ForkSession | Tombstone>(all.map((session) => [session.id, session]))
      return all.filter((session) => {
        let current: ForkSession | Tombstone | undefined = session
        const seen = new Set<string>()
        while (current?.forkFrom && !seen.has(current.id)) {
          seen.add(current.id)
          const parent = byId.get(current.forkFrom)
          if (!parent) return false
          current = parent
        }
        return current?.id === trunkID
      })
    }

    function projectState(key: string, currentID: string) {
      const entry = scan.projects[key]
      const tombstones = Object.values(deleted.entries).filter((item) => item.key === key)
      const sessions = entry?.sessions ?? []
      const trunkID = resolveTrunkID(sessions, tombstones, currentID)
      const component = componentSessions(sessions, tombstones, trunkID)
      const live = component.filter((session): session is ForkSession => !isTombstone(session))
      const ghosts = component.filter(isTombstone)
      return { entry, tombstones, trunkID, component, live, ghosts }
    }

    function labelFor(session: ForkSession, entry: MessageEntry | undefined): ForkLabel {
      if (entry?.status !== "ready") return { text: "…", created: session.created }
      const own = session.forkFrom ? entry.messages.filter((item) => item.created >= session.created) : entry.messages
      const first = own[0]
      if (first) return { text: compactMessage(first.text), created: first.created }
      if (!session.forkFrom) return { text: "(no user message)", created: session.created }
      return {
        text: isDefaultForkTitle(session.title) ? "New fork" : session.title!,
        created: session.created,
      }
    }

    function labelsFor(
      live: readonly ForkSession[],
      ghosts: readonly Tombstone[],
      entries: MessageState["entries"],
    ) {
      const labels: Record<string, ForkLabel> = {}
      for (const session of live) labels[session.id] = labelFor(session, entries[session.id])
      for (const ghost of ghosts)
        labels[ghost.id] = { text: ghost.label ?? "Deleted fork", created: ghost.labelCreated ?? ghost.created }
      return labels
    }

    function rememberDeleted(session: ForkSession, key: string, label: ForkLabel) {
      const entry: Tombstone = {
        id: session.id,
        title: session.title,
        forkFrom: session.forkFrom,
        boundary: session.boundary,
        created: session.created,
        key,
        deletedAt: Date.now(),
        label: label.text,
        labelCreated: label.created,
      }
      return setDeleted((draft) => {
        draft.entries[session.id] = entry
      })
    }

    function findSession(id: string) {
      for (const [key, entry] of Object.entries(scan.projects)) {
        const session = entry.sessions.find((item) => item.id === id)
        if (session) return { key, session, deleted: false }
      }
      const ghost = deleted.entries[id]
      if (ghost) return { key: ghost.key, session: ghost, deleted: true }
      return undefined
    }

    function patchTitle(sessionID: string, title: string) {
      setScan((draft) => {
        for (const entry of Object.values(draft.projects))
          for (const session of entry.sessions) if (session.id === sessionID) session.title = title
      })
    }

    function removeFromScan(sessionID: string) {
      setScan((draft) => {
        for (const entry of Object.values(draft.projects))
          entry.sessions = entry.sessions.filter((session) => session.id !== sessionID)
      })
    }

    function clearMessages() {
      setMessages((draft) => {
        draft.entries = {}
      })
    }

    function ephemeralInclude(id: string) {
      return ephemeral.ids.includes(id)
    }

    async function openMessagesDialog(
      sessionID: string,
      options: {
        keepPlaceholders?: boolean
        keepExpanded?: boolean
        focus?: string
      } = {},
    ) {
      const resolved = resolveCurrent(sessionID)
      const info = resolved.info
      if (!info) return
      const key = scanKey(info)
      if (!options.keepPlaceholders && ephemeral.ids.length) setEphemeral((draft) => (draft.ids = []))
      if (!options.keepExpanded) expanded.clear()
      const failed = await ensureScan(key, info).then(
        () => false,
        (error) => {
          toast(`Could not load forks: ${messageOf(error)}`, "error")
          return true
        },
      )
      if (failed) return
      const state = projectState(key, resolved.currentID)
      if (!state.live.length) return
      await ensureMessages(state.live.map((session) => session.id)).catch((error) => {
        toast(`Could not load messages: ${messageOf(error)}`, "error")
      })
      await ensureBoundaries(state.live)
      const messageMap = Object.fromEntries(
        state.live.map((session) => [session.id, messages.entries[session.id]?.messages ?? []]),
      )
      const boundaryMap: Record<string, BoundaryRecord> = {}
      for (const session of state.live) {
        const id = session.boundary?.messageID
        const record = id ? boundaries.entries[id]?.record : undefined
        if (id && record) boundaryMap[id] = record
      }
      const messageSessions: MessageSession[] = [
        ...state.live.map((session) => ({
          id: session.id,
          title: session.title,
          parentID: session.forkFrom,
          created: session.created,
          boundary: session.boundary,
        })),
        ...state.ghosts.map((ghost) => ({
          id: ghost.id,
          title: ghost.title,
          parentID: ghost.forkFrom,
          created: ghost.created,
          boundary: ghost.boundary,
          deleted: true,
          label: ghost.label,
          labelCreated: ghost.labelCreated,
        })),
      ]
      const tree = buildMessageTree({
        sessions: messageSessions,
        messages: messageMap,
        boundaries: boundaryMap,
        currentID: resolved.currentID,
        includeDeleted: ephemeralInclude,
        expanded,
      })
      if (!tree.rows.length) {
        toast("No user messages in this conversation", "info")
        return
      }
      const rowByKey = new Map(tree.rows.map((row) => [row.key, row]))
      const rowOf = (key: string) => rowByKey.get(key)
      const footer = (row: MessageRow) =>
        row.kind === "summary"
          ? "expand"
          : row.deleted
            ? "deleted"
            : row.kind === "branch"
              ? "new fork"
              : formatTime(row.created)
      const promise = context.ui.dialog.select({
        title: "Conversation tree",
        placeholder: "Search messages",
        options: tree.rows.map((row) => ({
          title: `${row.prefix}${row.glyph} ${row.text}`,
          value: row.key,
          footer: footer(row),
        })),
        current: options.focus && rowByKey.has(options.focus) ? options.focus : tree.currentKey,
        actions: [
          {
            bind: "ctrl+f",
            title: "fork here",
            side: "left",
            selection: "required",
            onTrigger: (key: string) => {
              const row = rowOf(key)
              if (!row || row.kind !== "message") return toast("Select a user message to fork", "info")
              void forkFlow(sessionID, resolved.currentID, row)
            },
          },
          {
            bind: "ctrl+r",
            title: "rename",
            side: "left",
            selection: "required",
            onTrigger: (key: string) => {
              const row = rowOf(key)
              if (!row || row.kind === "summary" || row.deleted) return
              void renameFlow(sessionID, row.sessionID, key)
            },
          },
          {
            bind: "ctrl+d",
            title: "delete",
            side: "left",
            selection: "required",
            onTrigger: (key: string) => {
              const row = rowOf(key)
              if (!row || row.kind === "summary" || row.deleted) return
              void deleteFlow(sessionID, row.sessionID, key)
            },
          },
          {
            bind: "ctrl+o",
            title: "expand",
            side: "left",
            selection: "required",
            onTrigger: (key: string) => {
              const row = rowOf(key)
              if (!row?.range) return
              expanded.add(`${row.range.sessionID}:${row.range.start}:${row.range.end}`)
              void openMessagesDialog(sessionID, {
                keepPlaceholders: true,
                keepExpanded: true,
                focus: key,
              })
            },
          },
        ],
      })
      context.ui.dialog.set({ size: "xlarge" })
      const selected = await promise
      if (selected === undefined) return
      const row = rowOf(selected)
      if (!row) return
      if (row.kind === "summary" && row.range) {
        expanded.add(`${row.range.sessionID}:${row.range.start}:${row.range.end}`)
        void openMessagesDialog(sessionID, { keepPlaceholders: true, keepExpanded: true })
        return
      }
      if (row.deleted) {
        toast("Session was deleted", "info")
        return
      }
      context.ui.router.navigate({ type: "session", sessionID: row.sessionID })
    }

    async function forkFlow(routeSessionID: string, currentID: string, row: MessageRow) {
      if (!row.messageID) return
      const source = messages.entries[row.sessionID]?.messages ?? []
      const message = source.find((item) => item.id === row.messageID)
      if (!message) return toast("Message not found", "error")
      const currentMessages = messages.entries[currentID]?.messages ?? []
      const copy = currentMessages.find((item) => item.created === message.created && item.text === message.text)
      const forked = await forkFromMessage(context, {
        sessionID: copy ? currentID : row.sessionID,
        message: copy ?? message,
      }).catch((error) => {
        toast(`Failed to fork: ${messageOf(error)}`, "error")
        return undefined
      })
      if (!forked) return
      context.ui.dialog.clear()
    }

    async function renameFlow(routeSessionID: string, sessionID: string, focus: string) {
      const found = findSession(sessionID)
      if (!found || found.deleted) return toast("Session not found", "error")
      const title = await context.ui.dialog.prompt({
        title: "Rename session",
        placeholder: "Session title",
        value: found.session.title,
      })
      if (title === undefined)
        return void openMessagesDialog(routeSessionID, { keepPlaceholders: true, keepExpanded: true, focus })
      const next = title.trim()
      if (!next) return void openMessagesDialog(routeSessionID, { keepPlaceholders: true, keepExpanded: true, focus })
      const updated = await context.client.session.update({ sessionID, title: next }).then(
        () => true,
        (error) => {
          toast(`Failed to rename session: ${messageOf(error)}`, "error")
          return false
        },
      )
      if (updated) patchTitle(sessionID, next)
      void openMessagesDialog(routeSessionID, { keepPlaceholders: true, keepExpanded: true, focus })
    }

    async function deleteFlow(routeSessionID: string, sessionID: string, focus: string) {
      const found = findSession(sessionID)
      if (!found || found.deleted) return toast("Session not found", "error")
      const session = found.session
      const label = labelFor(session, messages.entries[session.id])
      const confirmed = await context.ui.dialog.confirm({
        title: "Delete session",
        message: `Delete "${session.title ?? label.text}"? Subagent sessions are removed; forks are kept as placeholders.`,
        label: { confirm: "Delete", cancel: "Cancel" },
      })
      if (!confirmed)
        return void openMessagesDialog(routeSessionID, { keepPlaceholders: true, keepExpanded: true, focus })
      const removed = await context.client.session.remove({ sessionID }).then(
        () => true,
        (error) => {
          toast(`Failed to delete session: ${messageOf(error)}`, "error")
          return false
        },
      )
      if (!removed)
        return void openMessagesDialog(routeSessionID, { keepPlaceholders: true, keepExpanded: true, focus })
      await rememberDeleted(session, found.key, label).catch((error) => {
        toast(`Failed to remember deleted session: ${messageOf(error)}`, "error")
      })
      invalidateMessages(sessionID)
      setEphemeral((draft) => {
        if (!draft.ids.includes(sessionID)) draft.ids.push(sessionID)
      })
      invalidateScan()
      const route = context.ui.router.current()
      const current = route.type === "session" ? resolveCurrent(route.sessionID).currentID : undefined
      if (sessionID === current) return
      void openMessagesDialog(routeSessionID, {
        keepPlaceholders: true,
        keepExpanded: true,
        focus,
      })
    }

    async function handleDeleted(sessionID: string) {
      const found = findSession(sessionID)
      if (!found || found.deleted) return
      const label = labelFor(found.session, messages.entries[sessionID])
      const written = await rememberDeleted(found.session, found.key, label).then(
        () => true,
        (error) => {
          toast(`Failed to remember deleted session: ${messageOf(error)}`, "error")
          return false
        },
      )
      if (written) {
        setEphemeral((draft) => {
          if (!draft.ids.includes(sessionID)) draft.ids.push(sessionID)
        })
      }
      invalidateMessages(sessionID)
      removeFromScan(sessionID)
      invalidateScan()
    }

    const disposers = [
      context.data.on("session.forked", () => invalidateScan()),
      context.data.on("session.deleted", (event) => void handleDeleted(event.data.sessionID)),
      context.data.on("session.renamed", (event) => patchTitle(event.data.sessionID, event.data.title)),
      context.data.on("session.inbox.delivered", (event) => invalidateMessages(event.data.sessionID)),
      context.data.on("session.archived", (event) => {
        removeFromScan(event.data.sessionID)
        invalidateMessages(event.data.sessionID)
        invalidateScan()
      }),
      context.data.on("session.unarchived", () => invalidateScan()),
      context.data.on("session.moved", () => {
        invalidateScan()
        clearMessages()
      }),
      context.data.on("server.connected", () => {
        invalidateScan()
        clearMessages()
      }),
    ]

    const SidebarForks = (props: { sessionID: string }) => {
      const [view, updateView] = context.storage.store("view", { initial: { open: true } })
      const theme = context.theme
      const current = createMemo(() => resolveCurrent(props.sessionID))
      const key = createMemo(() => {
        const info = current().info
        return info ? scanKey(info) : undefined
      })
      const state = createMemo(() => {
        const value = key()
        if (!value) return undefined
        return projectState(value, current().currentID)
      })
      const labels = createMemo(() => {
        const value = state()
        if (!value) return {}
        return labelsFor(value.live, value.ghosts, messages.entries)
      })
      const tree = createMemo(() => {
        const value = state()
        if (!value) return emptyTree
        return buildForkTree({
          sessions: value.live,
          tombstones: value.ghosts,
          currentID: current().currentID,
          includeDeleted: ephemeralInclude,
          labels: labels(),
        })
      })
      const visible = createMemo(() => {
        const value = tree()
        return value.rows.length > 0 && (value.count > 0 || value.rows.some((row) => row.deleted))
      })
      const running = (id: string) => context.data.session.status(id) === "running"
      const toggle = () => {
        void updateView((draft) => {
          draft.open = !draft.open
        }).catch((error) => console.error("Failed to persist fork tree state", error))
      }

      createEffect(
        on(
          () => [current().info, scan.generation] as const,
          ([info]) => {
            if (!info) return
            const next = scanKey(info)
            untrack(() => void ensureScan(next, info).catch(() => {}))
          },
        ),
      )

      createEffect(
        on(
          () => state()?.live.map((session) => session.id).join("\n") ?? "",
          () => {
            const value = state()
            if (!value) return
            const ids = value.live.map((session) => session.id)
            if (!ids.length) return
            untrack(() => void ensureMessages(ids).catch(() => {}))
          },
        ),
      )

      return (
        <Show when={visible()}>
          <box>
            <box flexDirection="row" gap={1}>
              <box onMouseDown={toggle}>
                <text fg={theme.text.base}>{view.open ? "▼" : "▶"}</text>
              </box>
              <text
                fg={theme.text.base}
                onMouseUp={() => void openMessagesDialog(props.sessionID, { keepPlaceholders: false })}
              >
                <b>Forks</b>
                <span style={{ fg: theme.text.muted }}> {tree().count}</span>
              </text>
            </box>
            <Show when={view.open}>
              <For each={tree().rows}>
                {(row: ForkRow) => (
                  <box
                    flexDirection="row"
                    minWidth={0}
                    onMouseUp={() => {
                      if (row.deleted) return toast("Session was deleted", "info")
                      context.ui.router.navigate({ type: "session", sessionID: row.id })
                    }}
                  >
                    <text
                      fg={row.deleted ? theme.text.muted : theme.text.base}
                      flexGrow={1}
                      flexShrink={1}
                      minWidth={0}
                      wrapMode="none"
                      truncate
                    >
                      <span style={{ fg: theme.text.muted }}>{row.prefix}</span>
                      <span
                        style={{
                          fg: row.deleted
                            ? theme.text.muted
                            : row.isCurrent
                              ? theme.text.action.primary.selected
                              : running(row.id)
                                ? theme.text.feedback.info.base
                                : theme.text.muted,
                        }}
                      >
                        {row.glyph}{" "}
                      </span>
                      <Show when={row.isCurrent} fallback={row.label}>
                        <b>{row.label}</b>
                      </Show>
                    </text>
                    <text fg={theme.text.muted} flexShrink={0}>
                      {" "}
                      {row.deleted ? "deleted" : row.isCurrent ? "←" : formatTime(row.created)}
                    </text>
                  </box>
                )}
              </For>
            </Show>
          </box>
        </Show>
      )
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "fork-tree.open",
          title: "Open conversation tree",
          group: "Session",
          palette: true,
          slash: { name: "forks" },
          run: () => {
            const route = context.ui.router.current()
            if (route.type !== "session") return toast("Open a session first", "info")
            void openMessagesDialog(route.sessionID, { keepPlaceholders: false })
          },
        },
      ],
    }))

    context.ui.slot({
      prepend: "sidebar.content",
      render: (props) => <SidebarForks sessionID={props.sessionID} />,
    })

    return () => {
      for (const dispose of disposers) dispose()
    }
  },
})
