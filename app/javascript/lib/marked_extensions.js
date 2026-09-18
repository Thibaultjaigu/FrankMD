// Marked extensions for custom markdown syntax
// Adds support for: superscript, subscript, highlight, and emoji shortcodes

// Import emoji data from the picker controller
// We need to extract this to avoid circular dependencies
import { getEmojiMap } from "lib/emoji_data"
import { getIconMap } from "lib/icon_data"

// Superscript extension: ^text^ -> <sup>text</sup>
export const superscriptExtension = {
  name: "superscript",
  level: "inline",
  start(src) {
    return src.indexOf("^")
  },
  tokenizer(src) {
    // Match ^text^ but not ^^
    const match = src.match(/^\^([^\^]+)\^/)
    if (match) {
      return {
        type: "superscript",
        raw: match[0],
        text: match[1]
      }
    }
  },
  renderer(token) {
    return `<sup>${escapeHtml(token.text)}</sup>`
  }
}

// Subscript extension: ~text~ -> <sub>text</sub>
// Note: GFM uses ~~ for strikethrough, so we need single ~
export const subscriptExtension = {
  name: "subscript",
  level: "inline",
  start(src) {
    return src.indexOf("~")
  },
  tokenizer(src) {
    // Match ~text~ but not ~~ (strikethrough)
    const match = src.match(/^~([^~]+)~(?!~)/)
    if (match) {
      return {
        type: "subscript",
        raw: match[0],
        text: match[1]
      }
    }
  },
  renderer(token) {
    return `<sub>${escapeHtml(token.text)}</sub>`
  }
}

// Highlight extension: ==text== -> <mark>text</mark>
export const highlightExtension = {
  name: "highlight",
  level: "inline",
  start(src) {
    return src.indexOf("==")
  },
  tokenizer(src) {
    const match = src.match(/^==([^=]+)==/)
    if (match) {
      return {
        type: "highlight",
        raw: match[0],
        text: match[1]
      }
    }
  },
  renderer(token) {
    return `<mark>${escapeHtml(token.text)}</mark>`
  }
}

// Emoji extension: :shortcode: -> emoji character
export const emojiExtension = {
  name: "emoji",
  level: "inline",
  start(src) {
    return src.indexOf(":")
  },
  tokenizer(src) {
    // Match :shortcode: pattern
    const match = src.match(/^:([a-z0-9_+-]+):/)
    if (match) {
      const shortcode = match[1]
      const emojiMap = getEmojiMap()
      const emoji = emojiMap[shortcode]
      if (emoji) {
        return {
          type: "emoji",
          raw: match[0],
          emoji: emoji
        }
      }
    }
  },
  renderer(token) {
    return token.emoji
  }
}

// Icon extension: :ph-icon-name: -> inline Phosphor Icons SVG
export const iconExtension = {
  name: "icon",
  level: "inline",
  start(src) {
    return src.indexOf(":ph-")
  },
  tokenizer(src) {
    // Match :ph-icon-name: pattern
    const match = src.match(/^:ph-([a-z0-9-]+):/)
    if (match) {
      const name = match[1]
      const icon = getIconMap()[name]
      if (icon) {
        return {
          type: "icon",
          raw: match[0],
          path: icon.path,
          viewBox: icon.viewBox,
        }
      }
    }
  },
  renderer(token) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${token.viewBox}" fill="currentColor" width="1em" height="1em" class="frankmd-inline-icon" aria-hidden="true"><path d="${token.path}"/></svg>`
  },
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// Wikilink extension: [[Note Name]], [[Note Name|Display Text]], [[folder/Note Name]]
export const wikilinkExtension = {
  name: "wikilink",
  level: "inline",
  start(src) {
    return src.indexOf("[[")
  },
  tokenizer(src) {
    const match = src.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/)
    if (match) {
      const target = match[1].trim()
      const displayText = match[2] ? match[2].trim() : null
      return {
        type: "wikilink",
        raw: match[0],
        target: target,
        displayText: displayText
      }
    }
  },
  renderer(token) {
    // Use custom display text, or fall back to the basename of the target
    const display = token.displayText || token.target.split("/").pop()
    const escapedTarget = escapeHtml(token.target)
    const escapedDisplay = escapeHtml(display)
    return `<a class="wikilink" data-wikilink-path="${escapedTarget}" data-action="click->app#openWikilink">${escapedDisplay}</a>`
  }
}

// Math extensions (#164): TeX math via KaTeX, rendered WITHOUT weakening the
// DOMPurify boundary. The tokenizers emit escaped-TeX placeholders — plain text
// inside a class-tagged element, never `style` — so the sanitizer keeps them
// untouched. math_renderer.js then runs KaTeX over those placeholders AFTER
// sanitization (trust:false), so KaTeX's style-heavy output never has to pass
// through DOMPurify. See lib/math_renderer.js.

// Block math: $$ ... $$ (may span multiple lines). Block-level so the preview's
// line mapper annotates it for scroll-sync.
export const mathBlockExtension = {
  name: "mathBlock",
  level: "block",
  start(src) {
    const i = src.indexOf("$$")
    return i < 0 ? undefined : i
  },
  tokenizer(src) {
    // $$ must open at the start of the block; content is non-greedy up to the
    // next $$. Trailing newline(s) are consumed so the block separates cleanly.
    const match = src.match(/^\$\$([\s\S]+?)\$\$(?:\n+|$)/)
    if (match && match[1].trim().length > 0) {
      return {
        type: "mathBlock",
        raw: match[0],
        text: match[1].trim()
      }
    }
  },
  renderer(token) {
    return `<div class="math-block">${escapeHtml(token.text)}</div>\n`
  }
}

// Inline math: $ ... $. Deliberately conservative so prose with currency stays
// literal: the opening $ must not be followed by whitespace, the closing $ must
// not be preceded by whitespace nor followed by a digit ("$5 and $10" is not
// math). Backslash-escaped chars inside are allowed (\$ stays literal).
export const mathInlineExtension = {
  name: "mathInline",
  level: "inline",
  start(src) {
    // Only offer the first UNescaped "$"; \$ is a literal dollar sign.
    const i = src.search(/(?<!\\)\$/)
    return i < 0 ? undefined : i
  },
  tokenizer(src) {
    // Not $$ (that's block). Opening $ not followed by space; content allows
    // escaped chars; closing $ not preceded by space and not followed by digit.
    const match = src.match(/^\$(?!\$)(?!\s)((?:\\.|[^\\$])+?)(?<!\s)\$(?!\d)/)
    if (match) {
      return {
        type: "mathInline",
        raw: match[0],
        text: match[1]
      }
    }
  },
  renderer(token) {
    return `<span class="math-inline">${escapeHtml(token.text)}</span>`
  }
}

// Export all extensions as an array for easy use with marked.use()
export const allExtensions = [
  superscriptExtension,
  subscriptExtension,
  highlightExtension,
  emojiExtension,
  iconExtension,
  wikilinkExtension,
  mathBlockExtension,
  mathInlineExtension
]
