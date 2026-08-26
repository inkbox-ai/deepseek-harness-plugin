const MARKDOWN_LINK = /\[([^\]]+)]\(([^\s)]+)\)/g

function flattenTableRow(line: string): string {
  if ((line.match(/\|/g)?.length ?? 0) < 2) return line
  if (/^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line)) return ''
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim())
    .join(' · ')
}

export function toIMessagePlainText(value: string): string {
  return value
    .replaceAll('\r\n', '\n')
    .replace(/^\s*```[^\n]*$/gm, '')
    .replace(/^ {0,3}#{1,6}\s+/gm, '')
    .replace(/^ {0,3}>\s?/gm, '')
    .replace(/^ {0,3}(?:[-*+] |\d+[.)] )/gm, '')
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, '')
    .replace(/^ {4}/gm, '')
    .replace(/!\[([^\]]*)]\([^\s)]+\)/g, '$1')
    .replace(MARKDOWN_LINK, '$1: $2')
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|[.,!?;:]|$)/g, '$1$2')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|[.,!?;:]|$)/g, '$1$2')
    .split('\n')
    .map(flattenTableRow)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
