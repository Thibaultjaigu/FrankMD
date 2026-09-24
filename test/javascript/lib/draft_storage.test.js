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
