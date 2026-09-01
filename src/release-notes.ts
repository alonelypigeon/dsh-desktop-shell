// GitHub release body（Markdown/HTML 混排）→ 更新对话框纯文本 —— 纯函数，可单测。
// electron-updater 的 UpdateInfo.releaseNotes 来自 Release 描述，原样塞进
// 原生 dialog 会带满屏标签，这里剥成可读文本并限长。

export function stripHtmlToText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '· ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 截断到 max 字符（在最后一个完整行结尾截，附加省略号）。
export function truncateText(text: string, max = 1200): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastNl = cut.lastIndexOf('\n');
  return (lastNl > max * 0.5 ? cut.slice(0, lastNl) : cut).replace(/\s+$/, '') + '\n…';
}
