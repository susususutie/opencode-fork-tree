// 保留“今天/非今天”分支：今天仅 HH:mm，其他日期 MM-DD HH:mm（本地时区、24 小时制）。
export function formatTime(created: number) {
  const date = new Date(created)
  const pad = (value: number) => String(value).padStart(2, "0")
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (date.toDateString() === new Date().toDateString()) return time
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
}
