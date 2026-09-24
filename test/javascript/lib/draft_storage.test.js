import { describe, it, expect, vi } from "vitest"
import { DraftStorage } from "../../../app/javascript/lib/draft_storage"

class MemoryStorage {
  constructor() {
    this.values = new Map()
  }

  get length() { return this.values.size }
  key(index) { return Array.from(this.values.keys())[index] ?? null }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null }
  setItem(key, value) { this.values.set(key, String(value)) }
  removeItem(key) { this.values.delete(key) }
}

describe("DraftStorage", () => {
  it("stores and reads an empty draft with its server baseline", () => {
    const storage = new MemoryStorage()
    const drafts = new DraftStorage(() => storage)

    const write = drafts.writeDraft("folder/note.md", "", "server-revision")
    const read = drafts.readDraft("folder/note.md")

    expect(write.ok).toBe(true)
    expect(read).toEqual({ ok: true, draft: write.draft })
    expect(write.draft).toMatchObject({
      schemaVersion: 1,
      path: "folder/note.md",
      content: "",
      baseRevision: "server-revision"
    })
    expect(write.draft.draftRevision).toBeTruthy()
    expect(write.draft.updatedAt).toEqual(expect.any(Number))
  })

  it("skips an unchanged snapshot and keeps its exact draft revision", () => {
    const storage = new MemoryStorage()
    const setItem = vi.spyOn(storage, "setItem")
    const drafts = new DraftStorage(() => storage)

    const first = drafts.writeDraft("note.md", "same", "baseline")
    const second = drafts.writeDraft("note.md", "same", "baseline")

    expect(setItem).toHaveBeenCalledTimes(1)
    expect(second.unchanged).toBe(true)
    expect(second.draft.draftRevision).toBe(first.draft.draftRevision)
  })

  it("removes only the matching draft revision", () => {
    const storage = new MemoryStorage()
    const drafts = new DraftStorage(() => storage)
    const first = drafts.writeDraft("note.md", "older", "baseline")
    const second = drafts.writeDraft("note.md", "newer", "baseline")

    expect(drafts.removeDraftIfRevision("note.md", first.draft.draftRevision)).toEqual({ ok: true, removed: false })
    expect(drafts.readDraft("note.md").draft.draftRevision).toBe(second.draft.draftRevision)
    expect(drafts.removeDraftIfRevision("note.md", second.draft.draftRevision)).toEqual({ ok: true, removed: true })
    expect(drafts.readDraft("note.md").draft).toBeNull()
  })

  it("remaps a file draft and preserves its revision metadata", () => {
    const storage = new MemoryStorage()
    const drafts = new DraftStorage(() => storage)
    const original = drafts.writeDraft("notes/old.md", "local edit", "server-revision").draft

    expect(drafts.remapDrafts("notes/old.md", "archive/new.md")).toEqual({ ok: true, remapped: 1 })
    expect(drafts.readDraft("notes/old.md").draft).toBeNull()
    expect(drafts.readDraft("archive/new.md").draft).toEqual({ ...original, path: "archive/new.md" })
  })

  it("remaps only a folder path and its descendants", () => {
    const storage = new MemoryStorage()
    const drafts = new DraftStorage(() => storage)
    drafts.writeDraft("docs/index.md", "index", "rev-1")
    drafts.writeDraft("docs/guides/setup.md", "guide", "rev-2")
    drafts.writeDraft("docs-old/keep.md", "keep", "rev-3")

    expect(drafts.remapDrafts("docs", "archive", "folder")).toEqual({ ok: true, remapped: 2 })
    expect(drafts.readDraft("archive/index.md").draft.content).toBe("index")
    expect(drafts.readDraft("archive/guides/setup.md").draft.content).toBe("guide")
    expect(drafts.readDraft("docs-old/keep.md").draft.content).toBe("keep")
    expect(drafts.readDraft("docs/index.md").draft).toBeNull()
  })

  it("preserves both source and destination drafts when a remap collides", () => {
    const storage = new MemoryStorage()
    const drafts = new DraftStorage(() => storage)
    const source = drafts.writeDraft("old.md", "source version", "source-revision").draft
    const destination = drafts.writeDraft("new.md", "destination version", "destination-revision").draft

    const result = drafts.remapDrafts("old.md", "new.md")

    expect(result).toMatchObject({ ok: false, collision: true, sourcePath: "old.md", destinationPath: "new.md" })
    expect(drafts.readDraft("old.md").draft).toBeNull()
    expect(drafts.readDraft("new.md").draft).toEqual(destination)
    expect(drafts.listDraftConflicts("new.md").conflicts).toEqual([
      expect.objectContaining({
        conflictId: result.conflictId,
        path: "new.md",
        sourcePath: "old.md",
        content: "source version",
        draftRevision: source.draftRevision
      })
    ])
  })

  it("keeps every nested draft recoverable when a folder remap has one collision", () => {
    const storage = new MemoryStorage()
    const drafts = new DraftStorage(() => storage)
    drafts.writeDraft("docs/index.md", "index draft", "index-revision")
    const source = drafts.writeDraft("docs/guides/setup.md", "source guide", "source-revision").draft
    const destination = drafts.writeDraft("archive/guides/setup.md", "destination guide", "destination-revision").draft
    drafts.writeDraft("docs-old/keep.md", "unrelated", "keep-revision")

    const result = drafts.remapDrafts("docs", "archive", "folder")

    expect(result).toMatchObject({
      ok: false,
      collision: true,
      sourcePath: "docs/guides/setup.md",
      destinationPath: "archive/guides/setup.md"
    })
    expect(drafts.readDraft("docs/index.md").draft).toBeNull()
    expect(drafts.readDraft("archive/index.md").draft).toBeNull()
    expect(drafts.listDraftConflicts("archive/index.md").conflicts).toEqual([
      expect.objectContaining({ sourcePath: "docs/index.md", content: "index draft" })
    ])
    expect(drafts.readDraft("docs/guides/setup.md").draft).toBeNull()
    expect(drafts.readDraft("archive/guides/setup.md").draft).toEqual(destination)
    expect(drafts.listDraftConflicts("archive/guides/setup.md").conflicts).toEqual([
      expect.objectContaining({ sourcePath: source.path, content: source.content })
    ])
    expect(drafts.readDraft("docs-old/keep.md").draft.content).toBe("unrelated")
  })

  it("retains the source draft when a destination write fails", () => {
    const storage = new MemoryStorage()
    const drafts = new DraftStorage(() => storage)
    const source = drafts.writeDraft("old.md", "local edit", "revision").draft
    const originalSetItem = storage.setItem.bind(storage)
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (key === drafts.draftKey("new.md")) throw new Error("quota exceeded")
      originalSetItem(key, value)
    })

    expect(drafts.remapDrafts("old.md", "new.md")).toMatchObject({ ok: false, sourcePath: "old.md" })
    expect(drafts.readDraft("old.md").draft).toEqual(source)
    expect(drafts.readDraft("new.md").draft).toBeNull()
  })

  it("does not remove a source draft until the verified copy exists", () => {
    const storage = new MemoryStorage()
    const drafts = new DraftStorage(() => storage)
    const source = drafts.writeDraft("old.md", "local edit", "revision").draft
    const originalSetItem = storage.setItem.bind(storage)
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (key === drafts.draftKey("new.md")) return
      originalSetItem(key, value)
    })

    expect(drafts.remapDrafts("old.md", "new.md")).toMatchObject({ ok: false, sourcePath: "old.md" })
    expect(drafts.readDraft("old.md").draft).toEqual(source)
    expect(drafts.readDraft("new.md").draft).toBeNull()
  })

  it("retains both copies if removing the verified source fails", () => {
    const storage = new MemoryStorage()
    const drafts = new DraftStorage(() => storage)
    const source = drafts.writeDraft("old.md", "local edit", "revision").draft
    const originalRemoveItem = storage.removeItem.bind(storage)
    vi.spyOn(storage, "removeItem").mockImplementation((key) => {
      if (key === drafts.draftKey("old.md")) throw new Error("storage unavailable")
      originalRemoveItem(key)
    })

    expect(drafts.remapDrafts("old.md", "new.md")).toMatchObject({ ok: false, sourcePath: "old.md" })
    expect(drafts.readDraft("old.md").draft).toEqual(source)
    expect(drafts.readDraft("new.md").draft).toEqual({ ...source, path: "new.md" })
  })

  it("removes deleted file or folder drafts and backups by path boundary", () => {
    const storage = new MemoryStorage()
    const drafts = new DraftStorage(() => storage)
    drafts.writeDraft("docs/index.md", "index", "rev-1")
    drafts.writeDraft("docs/guides/setup.md", "guide", "rev-2")
    drafts.writeDraft("docs-old/keep.md", "keep", "rev-3")
    drafts.writeBackup("docs/index.md", "legacy")
    drafts.writeBackup("docs-old/keep.md", "keep legacy")

    expect(drafts.removeDrafts("docs", "folder")).toEqual({ ok: true, removed: 3 })
    expect(drafts.readDraft("docs/index.md").draft).toBeNull()
    expect(drafts.readDraft("docs/guides/setup.md").draft).toBeNull()
    expect(drafts.readDraft("docs-old/keep.md").draft.content).toBe("keep")
    expect(drafts.readBackup("docs/index.md").backup).toBeNull()
    expect(drafts.readBackup("docs-old/keep.md").backup.content).toBe("keep legacy")
  })

  it("removes recovery conflict copies when their file or folder is deleted", () => {
    const storage = new MemoryStorage()
    const drafts = new DraftStorage(() => storage)
    const source = drafts.writeDraft("docs/old.md", "source", "revision").draft
    drafts.writeDraft("docs/new.md", "destination", "other-revision")
    drafts.remapDrafts("docs/old.md", "docs/new.md")

    expect(drafts.listDraftConflicts("docs/new.md").conflicts).toHaveLength(1)
    expect(drafts.removeDrafts("docs", "folder").ok).toBe(true)
    expect(drafts.listDraftConflicts("docs/new.md").conflicts).toEqual([])
    expect(drafts.readDraft("docs/old.md").draft).toBeNull()
    expect(drafts.readDraft("docs/new.md").draft).toBeNull()
  })

  it("reports draft cleanup errors without throwing", () => {
    const storage = new MemoryStorage()
    const drafts = new DraftStorage(() => storage)
    drafts.writeDraft("note.md", "local edit", "revision")
    vi.spyOn(storage, "removeItem").mockImplementation(() => { throw new Error("storage unavailable") })

    expect(drafts.removeDrafts("note.md")).toMatchObject({ ok: false, removed: 0 })
  })

  it("discards malformed records without accepting unrelated local storage keys", () => {
    const storage = new MemoryStorage()
    const drafts = new DraftStorage(() => storage)
    storage.setItem("frankmd:draft:broken.md", "{bad json")
    storage.setItem("frankmd:draft:wrong-path", JSON.stringify({
      schemaVersion: 1,
      path: "another.md",
      content: "untrusted",
      baseRevision: "baseline",
      draftRevision: "revision",
      updatedAt: 1
    }))
    storage.setItem("another-app:key", "leave me")

    expect(drafts.readDraft("broken.md")).toMatchObject({ ok: true, draft: null, malformed: true })
    expect(drafts.listDrafts()).toEqual({ ok: true, drafts: [] })
    expect(drafts.removeAllDrafts()).toEqual({ ok: true })
    expect(storage.getItem("another-app:key")).toBe("leave me")
    expect(storage.getItem("frankmd:draft:broken.md")).toBeNull()
  })

  it("preserves draft records from a newer schema it cannot read", () => {
    const storage = new MemoryStorage()
    const drafts = new DraftStorage(() => storage)
    const raw = JSON.stringify({ schemaVersion: 2, content: "future draft" })
    storage.setItem("frankmd:draft:note.md", raw)

    const result = drafts.readDraft("note.md")

    expect(result.ok).toBe(false)
    expect(result.error.message).toContain("Unsupported draft schema version")
    expect(storage.getItem("frankmd:draft:note.md")).toBe(raw)
  })

  it("reports storage read, write, and removal failures to callers", () => {
    const error = new DOMException("QuotaExceededError")
    const storage = new MemoryStorage()
    const drafts = new DraftStorage(() => storage)

    vi.spyOn(storage, "getItem").mockImplementation(() => { throw error })
    expect(drafts.readDraft("note.md")).toEqual({ ok: false, error })
    expect(drafts.writeDraft("note.md", "content", "baseline")).toEqual({ ok: false, error })

    vi.restoreAllMocks()
    const writeFailingStorage = new MemoryStorage()
    const writeFailingDrafts = new DraftStorage(() => writeFailingStorage)
    vi.spyOn(writeFailingStorage, "setItem").mockImplementation(() => { throw error })
    expect(writeFailingDrafts.writeDraft("note.md", "content", "baseline")).toEqual({ ok: false, error })

    const removeFailingStorage = new MemoryStorage()
    const removeFailingDrafts = new DraftStorage(() => removeFailingStorage)
    const record = removeFailingDrafts.writeDraft("note.md", "content", "baseline")
    vi.spyOn(removeFailingStorage, "removeItem").mockImplementation(() => { throw error })
    expect(removeFailingDrafts.removeDraftIfRevision("note.md", record.draft.draftRevision)).toEqual({ ok: false, error })
  })

  it("continues to read and remove legacy offline backup records", () => {
    const storage = new MemoryStorage()
    const drafts = new DraftStorage(() => storage)

    expect(drafts.writeBackup("folder/note.md", "offline").ok).toBe(true)
    expect(drafts.readBackup("folder/note.md").backup.content).toBe("offline")
    expect(drafts.removeBackup("folder/note.md")).toEqual({ ok: true })
    expect(drafts.readBackup("folder/note.md").backup).toBeNull()
  })
})
