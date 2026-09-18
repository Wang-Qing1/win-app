import { useMemo } from 'react'
import { Flex, Typography } from 'antd'
import { estimatePages, estimateReadingSeconds, type PlatformSpec } from './platform-preview'
import { formatMinutes } from '../../lib/format'

const { Text } = Typography

interface PlatformPreviewProps {
  spec: PlatformSpec
  bookTitle: string
  /** 章节正文的纯文本。段落以空行分隔 */
  text: string
  charCount: number
  /** 当前选中的段落序号，用于与正文互相定位 */
  focusParagraph: number | null
  onSelectParagraph: (index: number | null) => void
}

/**
 * 手机阅读预览。
 *
 * 它的价值不在于「像素级还原某个 App」，而在于把**版式差异**摆到眼前：
 * 同一段文字，首行缩进与不缩进、段间空行与不空行，在手机上读起来的
 * 节奏完全不同。作者在电脑上写的时候感觉不到这种差别，而这恰恰是
 * 影响读者留存的因素之一。
 *
 * 因此实现上只做三件事：按平台规格排版、给出页数与阅读时长估算、
 * 提供「定位」把预览与正文对应起来。不做平台 UI 的仿真 —— 仿得越像，
 * 越容易让人误以为这是最终效果，而各平台随时会改版。
 */
export function PlatformPreview({
  spec,
  bookTitle,
  text,
  charCount,
  focusParagraph,
  onSelectParagraph
}: PlatformPreviewProps) {
  const paragraphs = useMemo(() => splitParagraphs(text), [text])
  const pages = estimatePages(charCount, spec)
  const readingSeconds = estimateReadingSeconds(charCount)

  return (
    <Flex vertical gap={6} className="preview">
      <Text type="secondary" className="preview__platform-note">
        {spec.label}：{spec.note}（字号 {spec.fontSize}px / 行距 {spec.lineHeight}）
      </Text>

      <div className="phone" data-testid="platform-preview">
        <div className="phone__notch" aria-hidden="true" />
        <div
          className="phone__screen"
          style={{ background: spec.background, color: spec.color, fontFamily: spec.fontFamily }}
        >
          <div className="phone__titlebar">
            <span className="phone__back">‹</span>
            <span className="phone__book">{bookTitle}</span>
          </div>

          <div
            className="phone__content"
            style={{
              fontSize: `${spec.fontSize}px`,
              lineHeight: spec.lineHeight
            }}
          >
            {paragraphs.length === 0 ? (
              <Text type="secondary" className="preview__empty">
                正文还是空的，写点什么就能看到手机上的效果。
              </Text>
            ) : (
              paragraphs.map((paragraph, index) => (
                <p
                  key={`${index}-${paragraph.slice(0, 8)}`}
                  data-paragraph-index={index}
                  className={`phone__paragraph${
                    focusParagraph === index ? ' phone__paragraph--focus' : ''
                  }`}
                  style={{
                    textIndent: spec.indentChars > 0 ? `${spec.indentChars}em` : '0',
                    marginBottom: spec.paragraphGapEm > 0 ? `${spec.paragraphGapEm}em` : '0'
                  }}
                  onClick={() => onSelectParagraph(focusParagraph === index ? null : index)}
                >
                  {paragraph}
                </p>
              ))
            )}
          </div>

          <div className="phone__footer">
            <span>
              {paragraphs.length > 0 ? `约 ${pages} 页` : '—'} · 共 {charCount} 字
            </span>
            <span>{readingSeconds > 0 ? `预计 ${formatMinutes(readingSeconds)}` : ''}</span>
          </div>
        </div>
      </div>

      <Text type="secondary" className="preview__disclaimer">
        相关预览页面仅供参考，具体以各平台实际实现为准。
      </Text>
    </Flex>
  )
}

/**
 * 按空行切段。
 *
 * 用 `/\n\s*\n/` 而不是单个 `\n`：编辑器的纯文本投影里，段落之间是
 * 一个空行，而段内的硬换行只有一个 `\n` —— 后者属于同一段的延续，
 * 不该被拆成两个段落（会造成预览里的段距多出一倍）。
 */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+$/, '').trim())
    .filter((paragraph) => paragraph.length > 0)
}
