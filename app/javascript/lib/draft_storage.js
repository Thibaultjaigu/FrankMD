const DRAFT_PREFIX = "frankmd:draft:"
const BACKUP_PREFIX = "frankmd:backup:"

let revisionCounter = 0

function nextDraftRevision() {
  revisionCounter += 1

  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()

  // The token is an equality guard, not a security credential. Keep it unique
  // across rapid writes even in browsers without randomUUID().
  return `${Date.now().toString(36)}-${revisionCounter.toString(36)}-${Math.random().toString(36).slice(2)}`
}

function validDraft(value, path) {
  return value &&
    value.schemaVersion === 1 &&
    value.path === path &&
    typeof value.content === "string" &&
    typeof value.baseRevision === "string" &&
    value.baseRevision.length > 0 &&
    typeof value.draftRevision === "string" &&
    value.draftRevision.length > 0 &&
    Number.isFinite(value.updatedAt)
}

function validBackup(value) {
  return value &&
    typeof value.content === "string" &&
    Number.isFinite(value.timestamp)
}

export class DraftStorage {
  constructor(storageProvider = () => globalThis.localStorage) {
    this.storageProvider = storageProvider
  }

  readDraft(path) {
    try {
      const raw = this.storageProvider().getItem(this.draftKey(path))
      if (raw === null) return { ok: true, draft: null }

      let draft
      try {
        draft = JSON.parse(raw)
      } catch {
        return this.discardMalformedDraft(path)
      }

      if (draft && typeof draft === "object" && typeof draft.schemaVersion === "number" && draft.schemaVersion !== 1) {
        return { ok: false, error: new Error(`Unsupported draft schema version: ${draft.schemaVersion}`) }
      }

      if (!validDraft(draft, path)) return this.discardMalformedDraft(path)
      return { ok: true, draft }
    } catch (error) {
      return { ok: false, error }
    }
  }

  writeDraft(path, content, baseRevision) {
    if (typeof path !== "string" || typeof content !== "string" || typeof baseRevision !== "string" || !baseRevision) {
      return { ok: false, error: new TypeError("A draft requires a path, string content, and server revision") }
    }

    const existingResult = this.readDraft(path)
    if (!existingResult.ok) return existingResult

    const existing = existingResult.draft
    if (existing && existing.content === content && existing.baseRevision === baseRevision) {
      return { ok: true, draft: existing, unchanged: true }
    }

    const draft = {
      schemaVersion: 1,
      path,
      content,
      baseRevision,
      draftRevision: nextDraftRevision(),
      updatedAt: Date.now()
    }

    try {
      this.storageProvider().setItem(this.draftKey(path), JSON.stringify(draft))
      return { ok: true, draft, unchanged: false }
    } catch (error) {
      return { ok: false, error }
    }
  }

  removeDraftIfRevision(path, draftRevision) {
    try {
      const storage = this.storageProvider()
      const key = this.draftKey(path)
      const raw = storage.getItem(key)
      if (raw === null) return { ok: true, removed: false }

      let draft
      try {
        draft = JSON.parse(raw)
      } catch {
        return { ok: true, removed: false }
      }

      if (!validDraft(draft, path) || draft.draftRevision !== draftRevision) {
        return { ok: true, removed: false }
      }

      storage.removeItem(key)
      return { ok: true, removed: true }
    } catch (error) {
      return { ok: false, error }
    }
  }

  removeDraft(path) {
    try {
      this.storageProvider().removeItem(this.draftKey(path))
      return { ok: true }
    } catch (error) {
      return { ok: false, error }
    }
  }

  listDrafts() {
    try {
      const storage = this.storageProvider()
      const keys = this.keysWithPrefix(storage, DRAFT_PREFIX)
      const drafts = []

      for (const key of keys) {
        const raw = storage.getItem(key)
        if (raw === null) continue

        let draft
        try {
          draft = JSON.parse(raw)
        } catch {
          continue
        }

        if (draft?.path && validDraft(draft, draft.path) && key === this.draftKey(draft.path)) {
          drafts.push(draft)
        }
      }

      return { ok: true, drafts }
    } catch (error) {
      return { ok: false, error }
    }
  }

  removeAllDrafts() {
    try {
      const storage = this.storageProvider()
      for (const key of this.keysWithPrefix(storage, DRAFT_PREFIX)) storage.removeItem(key)
      return { ok: true }
    } catch (error) {
      return { ok: false, error }
    }
  }

  readBackup(path) {
    try {
      const storage = this.storageProvider()
      const key = this.backupKey(path)
      const raw = storage.getItem(key)
      if (raw === null) return { ok: true, backup: null }

      let backup
      try {
        backup = JSON.parse(raw)
      } catch {
        return this.discardMalformedBackup(storage, key)
      }

      if (!validBackup(backup)) return this.discardMalformedBackup(storage, key)
      return { ok: true, backup }
    } catch (error) {
      return { ok: false, error }
    }
  }

  writeBackup(path, content) {
    if (typeof path !== "string" || typeof content !== "string") {
      return { ok: false, error: new TypeError("A backup requires a path and string content") }
    }

    try {
      this.storageProvider().setItem(this.backupKey(path), JSON.stringify({ content, timestamp: Date.now() }))
      return { ok: true }
    } catch (error) {
      return { ok: false, error }
    }
  }

  removeBackup(path) {
    try {
      this.storageProvider().removeItem(this.backupKey(path))
      return { ok: true }
    } catch (error) {
      return { ok: false, error }
    }
  }

  removeBackupIfSnapshot(path, content, timestamp) {
    try {
      const storage = this.storageProvider()
      const key = this.backupKey(path)
      const raw = storage.getItem(key)
      if (raw === null) return { ok: true, removed: false }

      let backup
      try {
        backup = JSON.parse(raw)
      } catch {
        return { ok: true, removed: false }
      }

      if (!validBackup(backup) || backup.content !== content || backup.timestamp !== timestamp) {
        return { ok: true, removed: false }
      }

      storage.removeItem(key)
      return { ok: true, removed: true }
    } catch (error) {
      return { ok: false, error }
    }
  }

  removeAllBackups() {
    try {
      const storage = this.storageProvider()
      for (const key of this.keysWithPrefix(storage, BACKUP_PREFIX)) storage.removeItem(key)
      return { ok: true }
    } catch (error) {
      return { ok: false, error }
    }
  }

  draftKey(path) {
    return DRAFT_PREFIX + encodeURIComponent(path)
  }

  backupKey(path) {
    // Keep the historic key format so backups written by older FrankMD
    // versions remain recoverable.
    return BACKUP_PREFIX + path
  }

  keysWithPrefix(storage, prefix) {
    const keys = []
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i)
      if (key?.startsWith(prefix)) keys.push(key)
    }
    return keys
  }

  discardMalformedDraft(path) {
    try {
      this.storageProvider().removeItem(this.draftKey(path))
      return { ok: true, draft: null, malformed: true }
    } catch (error) {
      return { ok: false, error }
    }
  }

  discardMalformedBackup(storage, key) {
    try {
      storage.removeItem(key)
      return { ok: true, backup: null, malformed: true }
    } catch (error) {
      return { ok: false, error }
    }
  }
}

const draftStorage = new DraftStorage()

export default draftStorage
