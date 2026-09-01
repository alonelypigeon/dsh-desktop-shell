import { describe, expect, it } from 'vitest';
import { stripHtmlToText, truncateText } from './release-notes';

describe('stripHtmlToText', () => {
  it('剥除标签，<br>/<p>/<li> 转换行，li 加项目符', () => {
    expect(stripHtmlToText('<p>v0.6.0</p><br>新增<b>命令面板</b>')).toBe('v0.6.0\n\n新增命令面板');
    expect(stripHtmlToText('<ul><li>通知</li><li>徽章</li></ul>')).toBe('· 通知\n· 徽章');
  });

  it('实体解码（&amp; 最后解码，避免双重解码）', () => {
    expect(stripHtmlToText('a &amp; b &lt;tag&gt; &quot;q&quot; &#39;c&#39;&nbsp;end')).toBe(
      "a & b <tag> \"q\" 'c' end",
    );
  });

  it('Markdown 原样保留；多余空行收敛', () => {
    expect(stripHtmlToText('### 标题\n\n- 项目\n\n\n- 项目2')).toBe('### 标题\n\n- 项目\n\n- 项目2');
  });

  it('纯文本原样返回', () => {
    expect(stripHtmlToText('  hello  ')).toBe('hello');
  });
});

describe('truncateText', () => {
  it('限长内原样返回', () => {
    expect(truncateText('short', 100)).toBe('short');
  });

  it('超长在行边界截断并加省略号', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\n');
    const out = truncateText(text, 100);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(102);
    // 截断点仍在完整行结尾
    expect(out.split('\n').every((l) => l.startsWith('line-') || l === '…')).toBe(true);
  });

  it('无合适行边界时硬截断', () => {
    const out = truncateText('x'.repeat(300), 100);
    expect(out.endsWith('…')).toBe(true);
  });
});
