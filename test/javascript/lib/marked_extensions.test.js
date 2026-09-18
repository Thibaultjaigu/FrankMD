/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest"
import { iconExtension, wikilinkExtension, mathInlineExtension, mathBlockExtension } from "../../../app/javascript/lib/marked_extensions.js"

describe("wikilinkExtension", () => {
  describe("start()", () => {
    it("returns index of [[ in source", () => {
      expect(wikilinkExtension.start("hello [[world]]")).toBe(6)
    })

    it("returns -1 when no [[ found", () => {
      expect(wikilinkExtension.start("no wikilinks here")).toBe(-1)
    })
  })

  describe("tokenizer()", () => {
    it("matches simple wikilink [[Note Name]]", () => {
      const token = wikilinkExtension.tokenizer("[[My Note]] rest")
      expect(token).toBeDefined()
      expect(token.type).toBe("wikilink")
      expect(token.raw).toBe("[[My Note]]")
      expect(token.target).toBe("My Note")
      expect(token.displayText).toBeNull()
    })

    it("matches wikilink with display text [[Note|Display]]", () => {
      const token = wikilinkExtension.tokenizer("[[My Note|Custom Label]] rest")
      expect(token).toBeDefined()
      expect(token.target).toBe("My Note")
      expect(token.displayText).toBe("Custom Label")
    })

    it("matches wikilink with path [[folder/Note]]", () => {
      const token = wikilinkExtension.tokenizer("[[projects/My Note]] rest")
      expect(token).toBeDefined()
      expect(token.target).toBe("projects/My Note")
      expect(token.displayText).toBeNull()
    })

    it("trims whitespace from target and display text", () => {
      const token = wikilinkExtension.tokenizer("[[  My Note  |  Label  ]] rest")
      expect(token.target).toBe("My Note")
      expect(token.displayText).toBe("Label")
    })

    it("returns undefined for non-matching input", () => {
      expect(wikilinkExtension.tokenizer("not a wikilink")).toBeUndefined()
    })

    it("returns undefined for unclosed brackets", () => {
      expect(wikilinkExtension.tokenizer("[[unclosed")).toBeUndefined()
    })
  })

  describe("renderer()", () => {
    it("renders simple wikilink as anchor tag", () => {
      const html = wikilinkExtension.renderer({ target: "My Note", displayText: null })
      expect(html).toContain('class="wikilink"')
      expect(html).toContain('data-wikilink-path="My Note"')
      expect(html).toContain('data-action="click->app#openWikilink"')
      expect(html).toContain(">My Note</a>")
    })

    it("renders wikilink with custom display text", () => {
      const html = wikilinkExtension.renderer({ target: "My Note", displayText: "Click here" })
      expect(html).toContain('data-wikilink-path="My Note"')
      expect(html).toContain(">Click here</a>")
    })

    it("renders path-based wikilink showing only basename", () => {
      const html = wikilinkExtension.renderer({ target: "projects/My Note", displayText: null })
      expect(html).toContain('data-wikilink-path="projects/My Note"')
      expect(html).toContain(">My Note</a>")
    })

    it("escapes HTML in display text", () => {
      const html = wikilinkExtension.renderer({ target: "Note", displayText: "<script>alert(1)</script>" })
      expect(html).not.toContain("<script>")
      expect(html).toContain("&lt;script&gt;")
    })

    it("escapes ampersands in target and display text", () => {
      const html = wikilinkExtension.renderer({ target: "Notes & Ideas", displayText: "R&D Notes" })
      expect(html).toContain('data-wikilink-path="Notes &amp; Ideas"')
      expect(html).toContain(">R&amp;D Notes</a>")
    })

    it("escapes quotes in target path", () => {
      const html = wikilinkExtension.renderer({ target: 'Note "with" quotes', displayText: null })
      expect(html).toContain("&quot;")
      expect(html).not.toContain('path="Note "with"')
    })
  })
})

describe("iconExtension", () => {
  describe("start()", () => {
    it("returns index of :ph- in source", () => {
      expect(iconExtension.start("hello :ph-heart: world")).toBe(6)
    })

    it("returns -1 when no :ph- prefix found", () => {
      expect(iconExtension.start("no icons here, just :smile:")).toBe(-1)
    })
  })

  describe("tokenizer()", () => {
    it("matches a known icon shortcode", () => {
      const token = iconExtension.tokenizer(":ph-heart: rest")
      expect(token).toBeDefined()
      expect(token.type).toBe("icon")
      expect(token.raw).toBe(":ph-heart:")
      expect(typeof token.path).toBe("string")
      expect(token.path.length).toBeGreaterThan(0)
      expect(token.viewBox).toBe("0 0 256 256")
    })

    it("returns undefined for an unknown icon name", () => {
      expect(iconExtension.tokenizer(":ph-not-a-real-icon:")).toBeUndefined()
    })

    it("returns undefined for a plain emoji shortcode", () => {
      expect(iconExtension.tokenizer(":smile:")).toBeUndefined()
    })

    it("returns undefined for non-matching input", () => {
      expect(iconExtension.tokenizer("not an icon")).toBeUndefined()
    })
  })

  describe("renderer()", () => {
    it("renders an inline SVG using the token's path and viewBox", () => {
      const html = iconExtension.renderer({ path: "M1 2 3", viewBox: "0 0 256 256" })

      expect(html).toContain("<svg")
      expect(html).toContain('viewBox="0 0 256 256"')
      expect(html).toContain('fill="currentColor"')
      expect(html).toContain('width="1em"')
      expect(html).toContain('height="1em"')
      expect(html).toContain('<path d="M1 2 3"/>')
      expect(html).toContain('class="frankmd-inline-icon"')
      expect(html).not.toContain('style="')
    })
  })
})

describe("mathInlineExtension", () => {
  describe("start()", () => {
    it("returns the index of the first unescaped $", () => {
      expect(mathInlineExtension.start("The equation is $E=mc^2$")).toBe(16)
    })

    it("ignores an escaped \\$ (currency stays literal)", () => {
      expect(mathInlineExtension.start("costs \\$5 today")).toBeUndefined()
    })

    it("returns undefined when there is no $", () => {
      expect(mathInlineExtension.start("no dollars here")).toBeUndefined()
    })
  })

  describe("tokenizer()", () => {
    it("matches simple inline math", () => {
      const t = mathInlineExtension.tokenizer("$E = mc^2$ rest")
      expect(t).toBeDefined()
      expect(t.type).toBe("mathInline")
      expect(t.text).toBe("E = mc^2")
      expect(t.raw).toBe("$E = mc^2$")
    })

    it("matches a single-token expression", () => {
      expect(mathInlineExtension.tokenizer("$x$").text).toBe("x")
    })

    it("does NOT match a lone currency value ($10.)", () => {
      expect(mathInlineExtension.tokenizer("$10.")).toBeUndefined()
    })

    it("does NOT match two currency values in a sentence", () => {
      expect(mathInlineExtension.tokenizer("$10 and that costs $20.")).toBeUndefined()
    })

    it("does NOT match when the closing $ is followed by a digit", () => {
      expect(mathInlineExtension.tokenizer("$100 to $200")).toBeUndefined()
    })

    it("rejects a space right after the opening $", () => {
      expect(mathInlineExtension.tokenizer("$ x$")).toBeUndefined()
    })

    it("rejects a space right before the closing $", () => {
      expect(mathInlineExtension.tokenizer("$x $")).toBeUndefined()
    })

    it("does NOT swallow a $$ block delimiter", () => {
      expect(mathInlineExtension.tokenizer("$$block$$")).toBeUndefined()
    })

    it("stops at the first valid closing $ so adjacent expressions are independent", () => {
      const t = mathInlineExtension.tokenizer("$a$ and $b$")
      expect(t.raw).toBe("$a$")
      expect(t.text).toBe("a")
    })

    it("keeps escaped \\$ inside the expression", () => {
      const t = mathInlineExtension.tokenizer("$a \\$ b$ rest")
      expect(t).toBeDefined()
      expect(t.text).toBe("a \\$ b")
    })
  })

  describe("renderer()", () => {
    it("emits a class-tagged span with the TeX as text, no style", () => {
      const html = mathInlineExtension.renderer({ text: "E = mc^2" })
      expect(html).toBe('<span class="math-inline">E = mc^2</span>')
      expect(html).not.toContain("style")
    })

    it("HTML-escapes the TeX so it cannot inject markup", () => {
      const html = mathInlineExtension.renderer({ text: "<img src=x onerror=alert(1)>" })
      expect(html).not.toContain("<img")
      expect(html).toContain("&lt;img")
    })
  })
})

describe("mathBlockExtension", () => {
  describe("start()", () => {
    it("returns the index of $$", () => {
      expect(mathBlockExtension.start("text\n$$\nx=y\n$$")).toBe(5)
    })

    it("returns undefined without $$", () => {
      expect(mathBlockExtension.start("no block here")).toBeUndefined()
    })
  })

  describe("tokenizer()", () => {
    it("matches a multiline display equation", () => {
      const t = mathBlockExtension.tokenizer("$$\nx = \\frac{-b}{2a}\n$$\nmore")
      expect(t).toBeDefined()
      expect(t.type).toBe("mathBlock")
      expect(t.text).toBe("x = \\frac{-b}{2a}")
    })

    it("matches a single-line $$...$$", () => {
      expect(mathBlockExtension.tokenizer("$$E=mc^2$$").text).toBe("E=mc^2")
    })

    it("does NOT match an empty/whitespace block (malformed)", () => {
      expect(mathBlockExtension.tokenizer("$$   $$")).toBeUndefined()
    })

    it("does NOT match an unterminated block", () => {
      expect(mathBlockExtension.tokenizer("$$\nx = y\n")).toBeUndefined()
    })
  })

  describe("renderer()", () => {
    it("emits a class-tagged div with the TeX as text, no style", () => {
      const html = mathBlockExtension.renderer({ text: "x = y" })
      expect(html).toBe('<div class="math-block">x = y</div>\n')
      expect(html).not.toContain("style")
    })

    it("HTML-escapes the TeX", () => {
      const html = mathBlockExtension.renderer({ text: "</div><script>alert(1)</script>" })
      expect(html).not.toContain("<script>")
      expect(html).toContain("&lt;script&gt;")
    })
  })
})
