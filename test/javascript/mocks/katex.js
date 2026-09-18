// Mock for KaTeX used in vitest. The real library ships a 267KB bundle and its
// own font metrics; the renderer tests only exercise OUR wiring (which nodes get
// rendered, the options passed, idempotency, error handling), so we stub
// katex.render to record calls and drop a marker into the target element.

export const __katexMock = {
  calls: [],
  throwNext: false,
  reset() {
    this.calls = []
    this.throwNext = false
  }
}

function render(tex, element, options = {}) {
  __katexMock.calls.push({ tex, options })
  if (__katexMock.throwNext) {
    __katexMock.throwNext = false
    throw new Error("katex boom")
  }
  element.innerHTML = `<span class="katex"></span>`
}

export default { render, renderToString: (tex) => tex, version: "mock" }
