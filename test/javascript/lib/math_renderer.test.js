/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from "vitest"
import { renderMathIn } from "../../../app/javascript/lib/math_renderer.js"
import { __katexMock } from "katex"

function container(html) {
  const el = document.createElement("div")
  el.innerHTML = html
  return el
}

describe("renderMathIn", () => {
  beforeEach(() => __katexMock.reset())

  it("renders an inline placeholder with displayMode false", () => {
    const el = container('<span class="math-inline">E = mc^2</span>')
    renderMathIn(el)

    expect(__katexMock.calls.length).toBe(1)
    expect(__katexMock.calls[0].tex).toBe("E = mc^2")
    expect(__katexMock.calls[0].options.displayMode).toBe(false)
    expect(el.querySelector(".math-inline").getAttribute("data-math-rendered")).toBe("")
  })

  it("renders a block placeholder with displayMode true", () => {
    const el = container('<div class="math-block">x = \\frac{1}{2}</div>')
    renderMathIn(el)

    expect(__katexMock.calls[0].options.displayMode).toBe(true)
    expect(__katexMock.calls[0].tex).toBe("x = \\frac{1}{2}")
  })

  it("always passes the hardened security options (trust:false)", () => {
    renderMathIn(container('<span class="math-inline">a</span>'))
    const opts = __katexMock.calls[0].options
    expect(opts.trust).toBe(false)
    expect(opts.throwOnError).toBe(false)
    expect(opts.maxExpand).toBe(1000)
  })

  it("renders multiple independent placeholders", () => {
    const el = container('<span class="math-inline">a</span><p>x</p><div class="math-block">b</div>')
    renderMathIn(el)
    expect(__katexMock.calls.map(c => c.tex)).toEqual(["a", "b"])
  })

  it("is idempotent — a second call does not re-render", () => {
    const el = container('<span class="math-inline">a</span>')
    renderMathIn(el)
    renderMathIn(el)
    expect(__katexMock.calls.length).toBe(1)
  })

  it("marks a node that made KaTeX throw and keeps going", () => {
    const el = container('<span class="math-inline">bad</span><span class="math-inline">good</span>')
    __katexMock.throwNext = true // first node throws
    renderMathIn(el)

    const nodes = el.querySelectorAll(".math-inline")
    expect(nodes[0].classList.contains("math-error")).toBe(true)
    expect(nodes[0].getAttribute("data-math-rendered")).toBe("") // still marked, won't retry
    expect(__katexMock.calls.length).toBe(2) // second node still rendered
  })

  it("does nothing for a null container", () => {
    expect(() => renderMathIn(null)).not.toThrow()
    expect(__katexMock.calls.length).toBe(0)
  })
})
