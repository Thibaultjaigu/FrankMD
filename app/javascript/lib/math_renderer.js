import katex from "katex"

// KaTeX math rendering for the markdown preview (#164).
//
// The markdown extensions (marked_extensions.js) emit text-only placeholders —
// <span class="math-inline">…</span> and <div class="math-block">…</div> — whose
// text content is the raw TeX. Those placeholders survive DOMPurify untouched
// (plain text + class, never `style`). We render them into KaTeX HERE, AFTER the
// sanitized HTML is in the DOM, so KaTeX's style-heavy output never has to pass
// through DOMPurify and we don't have to weaken the sanitizer's `style` ban.
//
// Security: `trust: false` blocks \href, \htmlClass, \includegraphics and the
// other commands that could inject arbitrary HTML/URLs/classes; the TeX itself
// is the note author's own content (same trust level as the rest of the note).
const KATEX_OPTIONS = {
  throwOnError: false, // render a TeX error inline (red) instead of throwing
  trust: false,        // no \href / \htmlId / arbitrary HTML from TeX
  strict: "ignore",
  maxExpand: 1000,     // bound macro expansion (DoS guard)
  output: "html"
}

// Render every not-yet-rendered math placeholder inside `container`.
// Idempotent: a `data-math-rendered` marker means "already done", so calling
// this twice on the same DOM (without a fresh render) won't duplicate work or
// re-read KaTeX output as TeX source.
export function renderMathIn(container) {
  if (!container) return

  const nodes = container.querySelectorAll(
    ".math-inline:not([data-math-rendered]), .math-block:not([data-math-rendered])"
  )

  nodes.forEach((el) => {
    const tex = el.textContent
    const displayMode = el.classList.contains("math-block")

    try {
      katex.render(tex, el, { ...KATEX_OPTIONS, displayMode })
    } catch {
      // throwOnError:false already renders TeX errors inline; this only catches
      // anything unexpected so one bad node can't break the rest of the preview.
      el.classList.add("math-error")
    }

    el.setAttribute("data-math-rendered", "")
  })
}
