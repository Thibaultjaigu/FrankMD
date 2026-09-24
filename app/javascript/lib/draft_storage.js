const DRAFT_PREFIX = "frankmd:draft:"
const DRAFT_CONFLICT_PREFIX = "frankmd:draft-conflict:"
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

  // Copy every draft attached to an item to its new path, verify each copy,
  // then remove the old keys. localStorage has no multi-key transaction, so
  // source records remain intact whenever copying or verification fails.
  remapDrafts(oldPath, newPath, type = "file") {
    if (typeof oldPath !== "string" || typeof newPath !== "string" || !oldPath || !newPath) {
      return { ok: false, error: new TypeError("Draft remapping requires source and destination paths") }
    }
    if (oldPath === newPath) return { ok: true, remapped: 0 }

    const listed = this.listDrafts()
    if (!listed.ok) return listed

    const candidates = listed.drafts.filter(draft => this.pathMatches(draft.path, oldPath, type))
    const plan = candidates.map(draft => ({
      sourcePath: draft.path,
      destinationPath: `${newPath}${draft.path.slice(oldPath.length)}`,
      draft
    }))
    const affectedPaths = plan
      .filter(item => item.sourcePath !== item.destinationPath)
      .map(item => item.destinationPath)
    const fail = result => ({ ...result, affectedPaths })
    const collisions = []

    // Check all destinations before writing any of them. A stale destination
    // draft may be the only copy of another note, so never overwrite it.
    for (const item of plan) {
      const sourceResult = this.readDraft(item.sourcePath)
      if (!sourceResult.ok) return fail(sourceResult)
      if (!sourceResult.draft || sourceResult.draft.draftRevision !== item.draft.draftRevision) {
        return fail({ ok: false, error: new Error(`Draft changed while remapping ${item.sourcePath}`) })
      }

      const destinationResult = this.readDraft(item.destinationPath)
      if (!destinationResult.ok) return fail(destinationResult)
      if (destinationResult.draft && !this.sameDraftRecord(destinationResult.draft, {
        ...item.draft,
        path: item.destinationPath
      })) {
        collisions.push(item)
        item.destinationExists = true
        continue
      }
      item.destinationExists = Boolean(destinationResult.draft)
    }

    const storageResult = this.getStorage()
    if (!storageResult.ok) return fail(storageResult)

    const storage = storageResult.storage
    let backupPlan
    try {
      backupPlan = this.keysWithPrefix(storage, BACKUP_PREFIX)
        .map(sourceKey => {
          const sourcePath = sourceKey.slice(BACKUP_PREFIX.length)
          if (!this.pathMatches(sourcePath, oldPath, type)) return null

          const raw = storage.getItem(sourceKey)
          if (raw === null) return null

          const destinationPath = `${newPath}${sourcePath.slice(oldPath.length)}`
          return {
            sourceKey,
            sourcePath,
            destinationPath,
            destinationKey: this.backupKey(destinationPath),
            raw
          }
        })
        .filter(Boolean)
    } catch (error) {
      return fail({ ok: false, error })
    }
    for (const item of backupPlan) {
      if (item.sourcePath !== item.destinationPath && !affectedPaths.includes(item.destinationPath)) {
        affectedPaths.push(item.destinationPath)
      }
    }

    // Legacy backups are keyed directly by path. Preflight every destination
    // before changing any record so an existing, unrelated recovery copy is
    // never silently replaced.
    for (const item of backupPlan) {
      if (item.sourcePath === item.destinationPath) continue
      let raw
      try {
        raw = storage.getItem(item.destinationKey)
      } catch (error) {
        return fail({ ok: false, error, sourcePath: item.sourcePath, destinationPath: item.destinationPath })
      }
      if (raw !== null && raw !== item.raw) {
        return fail({
          ok: false,
          backupCollision: true,
          error: new Error(`A legacy backup already exists at ${item.destinationPath}`),
          sourcePath: item.sourcePath,
          destinationPath: item.destinationPath
        })
      }
    }

    let conflictPlan
    try {
      conflictPlan = this.keysWithPrefix(storage, DRAFT_CONFLICT_PREFIX)
        .map(sourceKey => {
          const raw = storage.getItem(sourceKey)
          if (raw === null) return null
          let conflict
          try {
            conflict = JSON.parse(raw)
          } catch {
            return null
          }
          if (!this.validDraftConflict(conflict) || !this.pathMatches(conflict.path, oldPath, type)) return null

          const destinationPath = `${newPath}${conflict.path.slice(oldPath.length)}`
          return {
            sourceKey,
            sourcePath: conflict.path,
            destinationPath,
            destinationKey: this.draftConflictKey(destinationPath, conflict.conflictId),
            conflict,
            destinationExists: false
          }
        })
        .filter(Boolean)
    } catch (error) {
      return fail({ ok: false, error })
    }
    for (const item of conflictPlan) {
      if (item.sourcePath !== item.destinationPath && !affectedPaths.includes(item.destinationPath)) {
        affectedPaths.push(item.destinationPath)
      }
    }

    for (const item of conflictPlan) {
      if (item.sourcePath === item.destinationPath) continue
      let raw
      try {
        raw = storage.getItem(item.destinationKey)
      } catch (error) {
        return fail({ ok: false, error, sourcePath: item.sourcePath, destinationPath: item.destinationPath })
      }
      if (raw !== null) {
        let destination
        try {
          destination = JSON.parse(raw)
        } catch {
          return fail({ ok: false, error: new Error(`A recovery copy already exists at ${item.destinationPath}`) })
        }
        const expected = { ...item.conflict, path: item.destinationPath }
        if (!this.validDraftConflict(destination) || !this.sameDraftConflict(destination, expected)) {
          return fail({ ok: false, error: new Error(`A recovery copy already exists at ${item.destinationPath}`) })
        }
        item.destinationExists = true
      }
    }

    // A folder remap may contain several drafts, and a collision in one child
    // must not strand the remaining drafts at paths the server just removed.
    // Preserve each source draft at its new path before removing any source.
    if (collisions.length > 0) {
      const preservedDrafts = []
      for (const item of plan) {
        const listedConflicts = this.listDraftConflicts(item.destinationPath)
        if (!listedConflicts.ok) {
          return fail({ ...listedConflicts, sourcePath: item.sourcePath, destinationPath: item.destinationPath })
        }
        let conflict = listedConflicts.conflicts.find(candidate =>
          candidate.sourcePath === item.sourcePath &&
          candidate.content === item.draft.content &&
          candidate.baseRevision === item.draft.baseRevision &&
          candidate.draftRevision === item.draft.draftRevision &&
          candidate.updatedAt === item.draft.updatedAt
        )
        if (!conflict) {
          const preserved = this.preserveDraftConflict(item.destinationPath, item.draft)
          if (!preserved.ok) {
            return fail({ ...preserved, sourcePath: item.sourcePath, destinationPath: item.destinationPath })
          }
          conflict = preserved.conflict
        }
        preservedDrafts.push({ item, conflict })
      }

      // Existing recovery records also follow the moved folder. The source
      // record is retained until its destination copy has been verified.
      for (const item of conflictPlan) {
        if (item.sourcePath === item.destinationPath || item.destinationExists) continue
        const destinationConflict = { ...item.conflict, path: item.destinationPath }
        try {
          storage.setItem(item.destinationKey, JSON.stringify(destinationConflict))
        } catch (error) {
          return fail({ ok: false, error, sourcePath: item.sourcePath, destinationPath: item.destinationPath })
        }
        let verification
        try {
          verification = JSON.parse(storage.getItem(item.destinationKey) || "null")
        } catch (error) {
          return fail({ ok: false, error, sourcePath: item.sourcePath, destinationPath: item.destinationPath })
        }
        if (!this.validDraftConflict(verification) || !this.sameDraftConflict(verification, destinationConflict)) {
          return fail({
            ok: false,
            error: new Error(`Unable to verify the recovery copy at ${item.destinationPath}`),
            sourcePath: item.sourcePath,
            destinationPath: item.destinationPath
          })
        }
      }

      const backupCopy = this.copyLegacyBackups(storage, backupPlan)
      if (!backupCopy.ok) return fail(backupCopy)

      for (const { item } of preservedDrafts) {
        const removal = this.removeDraftIfRevision(item.sourcePath, item.draft.draftRevision)
        if (!removal.ok) return fail({ ...removal, sourcePath: item.sourcePath, destinationPath: item.destinationPath })
        if (!removal.removed) {
          return fail({
            ok: false,
            error: new Error(`The local draft at ${item.sourcePath} changed before it could be moved`),
            sourcePath: item.sourcePath,
            destinationPath: item.destinationPath
          })
        }
      }
      for (const item of conflictPlan) {
        if (item.sourcePath === item.destinationPath) continue
        const removal = this.removeDraftConflictIfRevision(item.sourcePath, item.conflict.conflictId, item.conflict.draftRevision)
        if (!removal.ok) return fail({ ...removal, sourcePath: item.sourcePath, destinationPath: item.destinationPath })
        if (!removal.removed) {
          return fail({
            ok: false,
            error: new Error(`The recovery copy at ${item.sourcePath} changed before it could be moved`),
            sourcePath: item.sourcePath,
            destinationPath: item.destinationPath
          })
        }
      }

      const backupRemoval = this.removeLegacyBackupSources(storage, backupPlan)
      if (!backupRemoval.ok) return fail(backupRemoval)

      const firstCollision = collisions[0]
      const conflict = preservedDrafts.find(({ item }) => item === firstCollision)?.conflict
      return fail({
        ok: false,
        collision: true,
        sourcePath: firstCollision.sourcePath,
        destinationPath: firstCollision.destinationPath,
        conflictId: conflict?.conflictId,
        collisions: collisions.map(item => ({ sourcePath: item.sourcePath, destinationPath: item.destinationPath })),
        error: new Error(`A local draft already exists at ${firstCollision.destinationPath}`)
      })
    }

    for (const item of plan) {
      if (item.sourcePath === item.destinationPath || item.destinationExists) continue

      const destinationDraft = { ...item.draft, path: item.destinationPath }
      try {
        storage.setItem(this.draftKey(item.destinationPath), JSON.stringify(destinationDraft))
      } catch (error) {
        return fail({ ok: false, error, sourcePath: item.sourcePath, destinationPath: item.destinationPath })
      }

      const verification = this.readDraft(item.destinationPath)
      if (!verification.ok) return fail({ ...verification, sourcePath: item.sourcePath, destinationPath: item.destinationPath })
      if (!verification.draft || !this.sameDraftRecord(verification.draft, destinationDraft)) {
        return fail({
          ok: false,
          error: new Error(`Unable to verify the local draft at ${item.destinationPath}`),
          sourcePath: item.sourcePath,
          destinationPath: item.destinationPath
        })
      }
    }

    for (const item of conflictPlan) {
      if (item.sourcePath === item.destinationPath || item.destinationExists) continue
      const destinationConflict = { ...item.conflict, path: item.destinationPath }
      try {
        storage.setItem(item.destinationKey, JSON.stringify(destinationConflict))
      } catch (error) {
        return fail({ ok: false, error, sourcePath: item.sourcePath, destinationPath: item.destinationPath })
      }
      let verification
      try {
        verification = JSON.parse(storage.getItem(item.destinationKey) || "null")
      } catch (error) {
        return fail({ ok: false, error, sourcePath: item.sourcePath, destinationPath: item.destinationPath })
      }
      if (!this.validDraftConflict(verification) || !this.sameDraftConflict(verification, destinationConflict)) {
        return fail({
          ok: false,
          error: new Error(`Unable to verify the recovery copy at ${item.destinationPath}`),
          sourcePath: item.sourcePath,
          destinationPath: item.destinationPath
        })
      }
    }

    const backupCopy = this.copyLegacyBackups(storage, backupPlan)
    if (!backupCopy.ok) return fail(backupCopy)

    // Only remove sources after every destination has been confirmed. A failed
    // removal leaves two valid copies, which is safer than losing the draft.
    for (const item of plan) {
      if (item.sourcePath === item.destinationPath) continue
      const removal = this.removeDraftIfRevision(item.sourcePath, item.draft.draftRevision)
      if (!removal.ok) return fail({ ...removal, sourcePath: item.sourcePath, destinationPath: item.destinationPath })
      if (!removal.removed) {
        return fail({
          ok: false,
          error: new Error(`The local draft at ${item.sourcePath} changed before it could be moved`),
          sourcePath: item.sourcePath,
          destinationPath: item.destinationPath
        })
      }
    }

    for (const item of conflictPlan) {
      if (item.sourcePath === item.destinationPath) continue
      const removal = this.removeDraftConflictIfRevision(item.sourcePath, item.conflict.conflictId, item.conflict.draftRevision)
      if (!removal.ok) return fail({ ...removal, sourcePath: item.sourcePath, destinationPath: item.destinationPath })
      if (!removal.removed) {
        return fail({
          ok: false,
          error: new Error(`The recovery copy at ${item.sourcePath} changed before it could be moved`),
          sourcePath: item.sourcePath,
          destinationPath: item.destinationPath
        })
      }
    }

    const backupRemoval = this.removeLegacyBackupSources(storage, backupPlan)
    if (!backupRemoval.ok) return fail(backupRemoval)

    return {
      ok: true,
      remapped: plan.filter(item => item.sourcePath !== item.destinationPath).length +
        conflictPlan.filter(item => item.sourcePath !== item.destinationPath).length +
        backupPlan.filter(item => item.sourcePath !== item.destinationPath).length
    }
  }

  copyLegacyBackups(storage, plan) {
    for (const item of plan) {
      if (item.sourcePath === item.destinationPath) continue

      let sourceRaw
      let destinationRaw
      try {
        sourceRaw = storage.getItem(item.sourceKey)
        destinationRaw = storage.getItem(item.destinationKey)
      } catch (error) {
        return { ok: false, error, sourcePath: item.sourcePath, destinationPath: item.destinationPath }
      }
      if (sourceRaw !== item.raw) {
        return {
          ok: false,
          error: new Error(`The legacy backup at ${item.sourcePath} changed while it was being moved`),
          sourcePath: item.sourcePath,
          destinationPath: item.destinationPath
        }
      }
      if (destinationRaw !== null && destinationRaw !== item.raw) {
        return {
          ok: false,
          backupCollision: true,
          error: new Error(`A legacy backup already exists at ${item.destinationPath}`),
          sourcePath: item.sourcePath,
          destinationPath: item.destinationPath
        }
      }

      if (destinationRaw === null) {
        try {
          storage.setItem(item.destinationKey, item.raw)
        } catch (error) {
          return { ok: false, error, sourcePath: item.sourcePath, destinationPath: item.destinationPath }
        }
      }

      let verification
      try {
        verification = storage.getItem(item.destinationKey)
      } catch (error) {
        return { ok: false, error, sourcePath: item.sourcePath, destinationPath: item.destinationPath }
      }
      if (verification !== item.raw) {
        return {
          ok: false,
          error: new Error(`Unable to verify the legacy backup at ${item.destinationPath}`),
          sourcePath: item.sourcePath,
          destinationPath: item.destinationPath
        }
      }
    }
    return { ok: true }
  }

  removeLegacyBackupSources(storage, plan) {
    for (const item of plan) {
      if (item.sourcePath === item.destinationPath) continue

      let sourceRaw
      try {
        sourceRaw = storage.getItem(item.sourceKey)
      } catch (error) {
        return { ok: false, error, sourcePath: item.sourcePath, destinationPath: item.destinationPath }
      }
      if (sourceRaw === null) continue
      if (sourceRaw !== item.raw) {
        return {
          ok: false,
          error: new Error(`The legacy backup at ${item.sourcePath} changed before it could be moved`),
          sourcePath: item.sourcePath,
          destinationPath: item.destinationPath
        }
      }

      try {
        storage.removeItem(item.sourceKey)
      } catch (error) {
        return { ok: false, error, sourcePath: item.sourcePath, destinationPath: item.destinationPath }
      }

      let remaining
      try {
        remaining = storage.getItem(item.sourceKey)
      } catch (error) {
        return { ok: false, error, sourcePath: item.sourcePath, destinationPath: item.destinationPath }
      }
      if (remaining !== null) {
        return {
          ok: false,
          error: new Error(`Unable to remove the legacy backup at ${item.sourcePath}`),
          sourcePath: item.sourcePath,
          destinationPath: item.destinationPath
        }
      }
    }
    return { ok: true }
  }

  // Remove a file's drafts, or drafts for a folder and its descendants. Also
  // remove legacy backups so deleted notes cannot be offered for recovery.
  removeDrafts(path, type = "file") {
    if (typeof path !== "string" || !path) {
      return { ok: false, error: new TypeError("Draft cleanup requires a path") }
    }

    const storageResult = this.getStorage()
    if (!storageResult.ok) return storageResult
    const storage = storageResult.storage
    let keys
    let backupKeys
    let conflictKeys
    try {
      keys = this.keysWithPrefix(storage, DRAFT_PREFIX)
      backupKeys = this.keysWithPrefix(storage, BACKUP_PREFIX)
      conflictKeys = this.keysWithPrefix(storage, DRAFT_CONFLICT_PREFIX)
    } catch (error) {
      return { ok: false, error, removed: 0 }
    }
    let firstError = null
    let removed = 0

    for (const key of keys) {
      const rawPath = key.slice(DRAFT_PREFIX.length)
      let keyPath
      try {
        keyPath = decodeURIComponent(rawPath)
      } catch {
        continue
      }
      if (!this.pathMatches(keyPath, path, type)) continue
      try {
        storage.removeItem(key)
        removed += 1
      } catch (error) {
        firstError ||= error
      }
    }

    for (const key of backupKeys) {
      const backupPath = key.slice(BACKUP_PREFIX.length)
      if (!this.pathMatches(backupPath, path, type)) continue
      try {
        storage.removeItem(key)
        removed += 1
      } catch (error) {
        firstError ||= error
      }
    }

    for (const key of conflictKeys) {
      let conflict
      try {
        conflict = JSON.parse(storage.getItem(key) || "null")
      } catch (error) {
        firstError ||= error
        continue
      }
      if (!this.validDraftConflict(conflict) || !this.pathMatches(conflict.path, path, type)) continue
      try {
        storage.removeItem(key)
        removed += 1
      } catch (error) {
        firstError ||= error
      }
    }

    return firstError ? { ok: false, error: firstError, removed } : { ok: true, removed }
  }

  listDraftConflicts(path) {
    try {
      const storage = this.storageProvider()
      const prefix = this.draftConflictPathPrefix(path)
      const conflicts = []
      for (const key of this.keysWithPrefix(storage, prefix)) {
        const raw = storage.getItem(key)
        if (raw === null) continue
        let conflict
        try {
          conflict = JSON.parse(raw)
        } catch {
          continue
        }
        if (this.validDraftConflict(conflict) && conflict.path === path && key === this.draftConflictKey(path, conflict.conflictId)) {
          conflicts.push(conflict)
        }
      }
      conflicts.sort((a, b) => a.updatedAt - b.updatedAt)
      return { ok: true, conflicts }
    } catch (error) {
      return { ok: false, error }
    }
  }

  preserveDraftConflict(path, draft) {
    if (!validDraft(draft, draft?.path) || typeof path !== "string" || !path) {
      return { ok: false, error: new TypeError("A draft conflict requires a valid draft and destination path") }
    }

    const conflictId = nextDraftRevision()
    const conflict = {
      schemaVersion: 1,
      path,
      sourcePath: draft.path,
      conflictId,
      content: draft.content,
      baseRevision: draft.baseRevision,
      draftRevision: draft.draftRevision,
      updatedAt: draft.updatedAt
    }

    try {
      const storage = this.storageProvider()
      const key = this.draftConflictKey(path, conflictId)
      storage.setItem(key, JSON.stringify(conflict))
      const saved = JSON.parse(storage.getItem(key) || "null")
      if (!this.validDraftConflict(saved) || saved.conflictId !== conflictId) {
        return { ok: false, error: new Error(`Unable to verify the recovery copy for ${path}`) }
      }
      return { ok: true, conflictId, conflict }
    } catch (error) {
      return { ok: false, error }
    }
  }

  removeDraftConflictIfRevision(path, conflictId, draftRevision) {
    try {
      const storage = this.storageProvider()
      const key = this.draftConflictKey(path, conflictId)
      const raw = storage.getItem(key)
      if (raw === null) return { ok: true, removed: false }
      let conflict
      try {
        conflict = JSON.parse(raw)
      } catch {
        return { ok: true, removed: false }
      }
      if (!this.validDraftConflict(conflict) || conflict.draftRevision !== draftRevision) {
        return { ok: true, removed: false }
      }
      storage.removeItem(key)
      return { ok: true, removed: true }
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
      for (const key of this.keysWithPrefix(storage, DRAFT_CONFLICT_PREFIX)) storage.removeItem(key)
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

  draftConflictKey(path, conflictId) {
    return `${this.draftConflictPathPrefix(path)}${conflictId}`
  }

  draftConflictPathPrefix(path) {
    return `${DRAFT_CONFLICT_PREFIX}${encodeURIComponent(path)}:`
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

  pathMatches(path, targetPath, type) {
    return type === "folder"
      ? path === targetPath || path.startsWith(`${targetPath}/`)
      : path === targetPath
  }

  sameDraftRecord(left, right) {
    return left.path === right.path &&
      left.content === right.content &&
      left.baseRevision === right.baseRevision &&
      left.draftRevision === right.draftRevision &&
      left.updatedAt === right.updatedAt
  }

  sameDraftConflict(left, right) {
    return left.path === right.path &&
      left.sourcePath === right.sourcePath &&
      left.conflictId === right.conflictId &&
      left.content === right.content &&
      left.baseRevision === right.baseRevision &&
      left.draftRevision === right.draftRevision &&
      left.updatedAt === right.updatedAt
  }

  validDraftConflict(value) {
    return value &&
      value.schemaVersion === 1 &&
      typeof value.path === "string" &&
      typeof value.sourcePath === "string" &&
      typeof value.conflictId === "string" &&
      typeof value.content === "string" &&
      typeof value.baseRevision === "string" &&
      typeof value.draftRevision === "string" &&
      Number.isFinite(value.updatedAt)
  }

  getStorage() {
    try {
      return { ok: true, storage: this.storageProvider() }
    } catch (error) {
      return { ok: false, error }
    }
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
