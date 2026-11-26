import { measureEditText, type WidthMethod } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import type { UserMessage } from "./messages"

// 把已发送的 user message 还原成 composer 的 PromptInfo，行为对齐宿主 /fork：
// - data:/file: URI 原样保留
// - media:<hash> 读取为 data URL
// - agent/skill/file mention 从字符偏移换算成单元格偏移
// - pasted 清空，agents 兜底为空数组

type Mention = { start: number; end: number; text?: string }
type MentionItem = { mention?: Mention }

type Attachment = {
  source?: { type?: string; uri?: string }
  uri?: string
  mime?: string
  data?: string
  name?: string
  description?: string
  mention?: Mention
}

type ProjectedFile = {
  uri: string
  name?: string
  description?: string
  mention?: Mention
}

type ProjectedAgent = {
  name: string
  mention?: Mention
}

type ProjectedSkill = {
  id: string
  mention?: Mention
}

export type PromptFile = ProjectedFile
export type PromptInfo = {
  text: string
  files?: PromptFile[]
  agents?: ProjectedAgent[]
  skills?: ProjectedSkill[]
  pasted: unknown[]
  mode?: "normal" | "shell"
}

type Projected = {
  text: string
  files?: ProjectedFile[]
  agents?: ProjectedAgent[]
  skills?: ProjectedSkill[]
}

const MEDIA_REF = /^media:([0-9a-f]{64})$/

export function projectedPromptInput(message: UserMessage): Projected {
  const files = (message.files as readonly Attachment[] | undefined)?.map((file) => ({
    uri:
      file.source?.type === "uri"
        ? (file.source.uri ?? "")
        : file.uri
          ? file.uri
          : `data:${file.mime ?? "application/octet-stream"};base64,${file.data ?? ""}`,
    name: file.name,
    description: file.description,
    mention: file.mention ? { ...file.mention } : undefined,
  }))
  const agents = (message.agents as readonly { name: string; mention?: Mention }[] | undefined)?.map((agent) => ({
    name: agent.name,
    mention: agent.mention ? { ...agent.mention } : undefined,
  }))
  const skills = (message.skills as readonly { id: string; mention?: Mention }[] | undefined)?.map((skill) => ({
    id: skill.id,
    mention: skill.mention ? { ...skill.mention } : undefined,
  }))
  return { text: message.text, files, agents, skills }
}

export function mentionsToCells<T extends Projected>(prompt: T, widthMethod: WidthMethod): T {
  const cells = (index: number) => measureEditText(prompt.text.slice(0, index), { widthMethod })
  const convert = <M extends MentionItem>(item: M): M => {
    const mention = item.mention
    if (!mention?.text || prompt.text.slice(mention.start, mention.end) !== mention.text) return item
    for (let at = prompt.text.indexOf(mention.text); at !== -1; at = prompt.text.indexOf(mention.text, at + 1))
      if (cells(at) === mention.start) return item
    return { ...item, mention: { ...mention, start: cells(mention.start), end: cells(mention.end) } }
  }
  return {
    ...prompt,
    files: prompt.files?.map(convert),
    agents: prompt.agents?.map(convert),
    skills: prompt.skills?.map(convert),
  }
}

export async function restorePrompt(context: Plugin.Context, message: UserMessage): Promise<PromptInfo> {
  const projected = projectedPromptInput(message)
  const files = await Promise.all(
    (projected.files ?? []).map(async (file, index) => {
      const hash = MEDIA_REF.exec(file.uri)?.[1]
      if (!hash) return file
      const bytes = await context.client.experimental.media.get({ hash })
      const mime = (message.files as readonly Attachment[] | undefined)?.[index]?.mime ?? "application/octet-stream"
      return { ...file, uri: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` }
    }),
  )
  const prompt = mentionsToCells({ ...projected, files }, context.renderer.widthMethod)
  return { ...prompt, pasted: [] }
}

export async function forkFromMessage(
  context: Plugin.Context,
  input: { sessionID: string; message: UserMessage },
) {
  // 与宿主 DialogFork 一致：先还原 prompt，再创建 fork；还原失败不产生新会话。
  const prompt = await restorePrompt(context, input.message)
  const forked = await context.client.session.fork({ sessionID: input.sessionID, before: input.message.id })
  // 插件的 Destination 类型没有 prompt 字段，宿主 SessionRoute 本身支持；运行时透传。
  const destination = {
    type: "session" as const,
    sessionID: forked.id,
    prompt: { ...prompt, agents: prompt.agents ?? [] },
  }
  context.ui.router.navigate(destination)
  return forked
}
