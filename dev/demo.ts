import { buildMessageTree, type BoundaryRecord, type MessageSession, type MessageTree, type UserMessage } from "../messages"

// 固定时间基准，demo 不依赖真实数据。
const BASE = Date.UTC(2026, 10, 26, 2, 0, 0)
const at = (minutes: number) => BASE + minutes * 60_000
const user = (id: string, minutes: number, text: string): UserMessage => ({ id, created: at(minutes), text })

const mainMessages: UserMessage[] = [
  user("t1", 1, "初始 user message：整理需求、范围与验收标准"),
  user("t2", 2, "确认第一版方案，先跑通主流程"),
  user("t3", 3, "开始实现登录与鉴权"),
  user("t4", 4, "补充错误码和空状态"),
  user("t5", 5, "把接口契约写成文档"),
  user("t6", 6, "检查移动端布局"),
  user("t7", 7, "补充单元测试"),
  user("t8", 8, "处理列表分页"),
  user("t9", 9, "优化首屏加载"),
  user("t10", 10, "修复重试逻辑"),
  user("t11", 11, "确认灰度发布方案"),
  user("t12", 12, "补充监控与告警"),
  user("t13", 13, "整理回归清单"),
  user("t14", 14, "检查权限边界"),
  user("t15", 15, "更新 README"),
  user("t16", 16, "最后一轮自查"),
  user("t17", 17, "准备发布说明"),
  user("t18", 18, "发布候选版本"),
  user("t19", 19, "观察线上指标"),
  user("t20", 20, "收尾并归档"),
]

export const demoBoundaries: Record<string, BoundaryRecord> = {
  idle3: { created: at(3), isUser: false },
  idle6: { created: at(6), isUser: false },
  idle9: { created: at(9), isUser: false },
  idle11: { created: at(11), isUser: false },
  a1: { created: at(5), isUser: true },
  a1x: { created: at(6), isUser: true },
  d1: { created: at(11), isUser: true },
}

export const demoSessions: MessageSession[] = [
  { id: "main", title: "多 lane 演示", created: at(0) },
  { id: "a", title: "登录分支", parentID: "main", created: at(3.2), boundary: { type: "through", messageID: "idle3" } },
  { id: "a1", title: "token 校验子分支", parentID: "a", created: at(4.2), boundary: { type: "through", messageID: "a1" } },
  {
    id: "a1a",
    title: "401/403 子分支",
    parentID: "a1",
    created: at(5.2),
    boundary: { type: "through", messageID: "a1x" },
  },
  { id: "b", title: "移动端分支", parentID: "main", created: at(6.2), boundary: { type: "through", messageID: "idle6" } },
  {
    id: "d",
    title: "已删除的分支",
    parentID: "main",
    created: at(9.2),
    boundary: { type: "through", messageID: "idle9" },
    deleted: true,
    label: "已删除的分支 · 保留结构",
    labelCreated: at(9.5),
  },
  { id: "d1", title: "删除分支的子分支", parentID: "d", created: at(10.2), boundary: { type: "through", messageID: "d1" } },
  { id: "e", title: "空分支", parentID: "main", created: at(11.2), boundary: { type: "through", messageID: "idle11" } },
]

export const demoMessages: Record<string, UserMessage[]> = {
  main: mainMessages,
  a: [
    user("a1", 5, "先实现 OAuth 回调与 state 校验"),
    user("a2", 12, "补充 token 刷新失败后的重新登录"),
    user("a3", 17, "处理并发登录时的旧 token 失效"),
  ],
  a1: [user("a1x", 6, "增加 scope 校验"), user("a1y", 13, "补充审计日志")],
  a1a: [user("a1a", 7, "区分 401 与 403 的提示与跳转")],
  b: [user("b1", 8, "调整移动端断点与抽屉交互")],
  d1: [user("d1x", 11, "被删除分支的子消息"), user("d1y", 12, "子分支仍然保留的后续消息")],
}

export function buildDemoTree(expanded: ReadonlySet<string> = new Set()): MessageTree {
  return buildMessageTree({
    sessions: demoSessions,
    messages: demoMessages,
    boundaries: demoBoundaries,
    currentID: "a1a",
    includeDeleted: () => true,
    expanded,
    context: 2,
  })
}

export function renderDemo(tree: MessageTree = buildDemoTree()) {
  return tree.rows.map((row) => `${row.prefix}${row.glyph} ${row.text}${row.current ? "  ←" : ""}`).join("\n")
}
