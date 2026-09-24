import { Controller } from "@hotwired/stimulus"
import { patch } from "@rails/request.js"
import { encodePath } from "lib/url_utils"
import draftStorage from "lib/draft_storage"
import { undo } from "@codemirror/commands"

export default class extends Controller {
  static targets = ["contentLossBanner", "saveStatus"]
  static outlets = ["codemirror", "offline-backup", "recovery-diff"]

  // Auto-save configuration
  static SAVE_DEBOUNCE_MS = 2000      // Wait 2 seconds after last keystroke
  static SAVE_MAX_INTERVAL_MS = 30000 // Force save every 30 seconds if continuously typing
  static DRAFT_DEBOUNCE_MS = 300

  connect() {
    this.currentFile = null
    this.saveTimeout = null
    this.saveMaxIntervalTimeout = null
    this.isOffline = false
    this.hasUnsavedChanges = false
    this._isSaving = false
    this._lastSavedContent = null
    this._lastSaveTime = 0
    this._fileVersion = 0
    this._contentLossWarningActive = false
    this._contentLossOverride = false
    this._offlineBackupTimeout = null
    this._draftWriteTimeouts = new Map()
    this._knownBaseRevisions = new Map()
    this._baseRevision = null
    this._draftRevision = null
    this._pendingRecovery = null
  }

  disconnect() {
    if (this.saveTimeout) clearTimeout(this.saveTimeout)
    if (this.saveMaxIntervalTimeout) clearTimeout(this.saveMaxIntervalTimeout)
    if (this._offlineBackupTimeout) clearTimeout(this._offlineBackupTimeout)
    for (const timeout of this._draftWriteTimeouts.values()) clearTimeout(timeout)
    this._draftWriteTimeouts.clear()
  }

  // === Controller Getters (via Stimulus Outlets) ===

  getCodemirrorController() { return this.codemirrorOutlets[0] ?? null }
  getOfflineBackupController() { return this.offlineBackupOutlets[0] ?? null }
  getRecoveryDiffController() { return this.recoveryDiffOutlets[0] ?? null }

  hasPendingRecovery(path = this.currentFile) {
    return this._pendingRecovery?.path === path
  }

  // === Public API (called by app controller) ===

  setFile(path, content, revision = null) {
    this.currentFile = path
    this._lastSavedContent = content
    this._baseRevision = typeof revision === "string" && revision ? revision : null
    this._draftRevision = null
    if (this._baseRevision) this._knownBaseRevisions.set(path, this._baseRevision)
    this.hasUnsavedChanges = false
    this._fileVersion += 1
  }

  // Keep autosave attached to a note when its path changes without loading it
  // as a new file. In particular, do not reset the dirty state here: a rename
  // must not make pending editor changes look persisted.
  renameFile(oldPath, newPath, type = "file") {
    const remappedPath = this.remapPath(this.currentFile, oldPath, newPath, type)
    if (remappedPath === this.currentFile) return false

    this.currentFile = remappedPath
    this._fileVersion += 1
    return true
  }

  // Invalidate all autosave state for a deleted note. A save already in flight
  // cannot be cancelled reliably, so saveNow() also verifies its captured file
  // version before applying a response.
  deleteFile(path, type = "file") {
    if (!this.pathMatches(this.currentFile, path, type)) return false

    const backupController = this.getOfflineBackupController()
    if (backupController) backupController.clear(this.currentFile)

    this.clearPendingTimers()
    this.currentFile = null
    this._lastSavedContent = null
    this.hasUnsavedChanges = false
    this._fileVersion += 1
    this.dismissContentLossWarning()
    this.showSaveStatus("")
    return true
  }

  remapPath(path, oldPath, newPath, type = "file") {
    if (!path) return path

    if (type === "folder") {
      if (path === oldPath || path.startsWith(`${oldPath}/`)) {
        return `${newPath}${path.slice(oldPath.length)}`
      }
      return path
    }

    return path === oldPath ? newPath : path
  }

  pathMatches(path, targetPath, type = "file") {
    if (!path) return false
    if (type === "folder") {
      return path === targetPath || path.startsWith(`${targetPath}/`)
    }
    return path === targetPath
  }

  clearPendingTimers() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout)
      this.saveTimeout = null
    }
    if (this.saveMaxIntervalTimeout) {
      clearTimeout(this.saveMaxIntervalTimeout)
      this.saveMaxIntervalTimeout = null
    }
    if (this._offlineBackupTimeout) {
      clearTimeout(this._offlineBackupTimeout)
      this._offlineBackupTimeout = null
    }
  }

  scheduleDraftWrite() {
    const path = this.currentFile
    const baseRevision = this._baseRevision
    if (!path || !baseRevision || this.hasPendingRecovery(path)) return

    const cm = this.getCodemirrorController()
    const content = cm ? cm.getValue() : ""
    if (content === this._lastSavedContent) {
      this.clearDraftWriteTimeout(path)
      if (this._draftRevision) this.removeDraftIfRevision(path, this._draftRevision)
      return
    }

    const previousTimeout = this._draftWriteTimeouts.get(path)
    if (previousTimeout) clearTimeout(previousTimeout)

    const snapshot = { path, content, baseRevision }
    const timeout = setTimeout(() => {
      this._draftWriteTimeouts.delete(path)
      this.writeDraftSnapshot(snapshot)
    }, this.constructor.DRAFT_DEBOUNCE_MS)
    this._draftWriteTimeouts.set(path, timeout)
  }

  flushDraftWrite(path = this.currentFile, content = null, baseRevision = this._baseRevision) {
    if (!path || !baseRevision || this.hasPendingRecovery(path)) return { ok: true, draft: null }

    const cm = this.getCodemirrorController()
    const snapshotContent = content === null ? (cm ? cm.getValue() : "") : content
    this.clearDraftWriteTimeout(path)

    if (snapshotContent === this._lastSavedContent && path === this.currentFile) {
      if (this._draftRevision) {
        const result = draftStorage.removeDraftIfRevision(path, this._draftRevision)
        if (!result.ok) this.showDraftStorageError(result.error)
        else this._draftRevision = null
        return result
      }
      return { ok: true, draft: null }
    }

    return this.writeDraftSnapshot({ path, content: snapshotContent, baseRevision })
  }

  writeDraftSnapshot(snapshot) {
    if (this.hasPendingRecovery(snapshot.path)) return { ok: true, draft: null, blocked: true }

    const latestBaseRevision = this._knownBaseRevisions.get(snapshot.path)
    const baseRevision = latestBaseRevision || snapshot.baseRevision
    const result = draftStorage.writeDraft(snapshot.path, snapshot.content, baseRevision)

    if (!result.ok) {
      if (snapshot.path === this.currentFile) this.showDraftStorageError(result.error)
      return result
    }

    if (snapshot.path === this.currentFile) this._draftRevision = result.draft.draftRevision
    return result
  }

  clearDraftWriteTimeout(path) {
    const timeout = this._draftWriteTimeouts.get(path)
    if (timeout) {
      clearTimeout(timeout)
      this._draftWriteTimeouts.delete(path)
    }
  }

  removeDraftIfRevision(path, revision) {
    const result = draftStorage.removeDraftIfRevision(path, revision)
    if (!result.ok) {
      this.showDraftStorageError(result.error)
    } else if (result.removed && path === this.currentFile && revision === this._draftRevision) {
      this._draftRevision = null
    }
    return result
  }

  showDraftStorageError(error) {
    console.error("Unable to persist local draft:", error)
    this.showSaveStatus(window.t("status.draft_storage_error"), true)
  }

  readLegacyBackup(path, serverContent) {
    const result = draftStorage.readBackup(path)
    if (!result.ok) {
      this.showDraftStorageError(result.error)
      return null
    }

    const backup = result.backup
    if (backup && backup.content === serverContent) {
      const removal = draftStorage.removeBackup(path)
      if (!removal.ok) this.showDraftStorageError(removal.error)
      return null
    }
    return backup
  }

  openRecovery({ path, serverContent, content, timestamp, source, draftRevision = null }) {
    const recovery = this.getRecoveryDiffController()
    if (!recovery) return false

    if (path === this.currentFile) {
      this.clearDraftWriteTimeout(path)
      this.clearPendingTimers()
    }

    recovery.open({
      path,
      serverContent,
      backupContent: content,
      backupTimestamp: timestamp,
      source,
      draftRevision
    })
    this._pendingRecovery = { path, draftRevision }
    return true
  }

  recoverDraft(serverContent, serverRevision) {
    const path = this.currentFile
    if (!path) return serverContent

    const readResult = draftStorage.readDraft(path)
    if (!readResult.ok) {
      this.showDraftStorageError(readResult.error)
      const backup = this.readLegacyBackup(path, serverContent)
      if (backup) this.openRecovery({ path, serverContent, content: backup.content, timestamp: backup.timestamp, source: "backup" })
      return serverContent
    }

    const draft = readResult.draft
    const backup = this.readLegacyBackup(path, serverContent)

    if (!draft) {
      if (backup) this.openRecovery({ path, serverContent, content: backup.content, timestamp: backup.timestamp, source: "backup" })
      return serverContent
    }

    // Draft records are the new source of truth. A legacy backup only takes
    // precedence when it is a different, later snapshot; that case requires an
    // explicit recovery choice instead of silently overwriting either copy.
    if (backup && backup.content !== draft.content && backup.timestamp > draft.updatedAt) {
      this.openRecovery({
        path,
        serverContent,
        content: backup.content,
        timestamp: backup.timestamp,
        source: "backup",
        draftRevision: draft.draftRevision
      })
      return serverContent
    }

    if (backup) {
      const removal = draftStorage.removeBackup(path)
      if (!removal.ok) this.showDraftStorageError(removal.error)
    }

    if (draft.content === serverContent) {
      this.removeDraftIfRevision(path, draft.draftRevision)
      return serverContent
    }

    if (draft.baseRevision === serverRevision) {
      this._draftRevision = draft.draftRevision
      this.hasUnsavedChanges = true
      this.showSaveStatus(window.t("status.unsaved"))
      return draft.content
    }

    this.openRecovery({
      path,
      serverContent,
      content: draft.content,
      timestamp: draft.updatedAt,
      source: "draft",
      draftRevision: draft.draftRevision
    })
    return serverContent
  }

  checkOfflineBackup(serverContent) {
    const backup = this.getOfflineBackupController()
    if (!backup) return
    const data = backup.check(this.currentFile, serverContent)
    if (!data) return
    const recovery = this.getRecoveryDiffController()
    if (recovery) {
      this.openRecovery({
        path: this.currentFile,
        serverContent,
        content: data.content,
        timestamp: data.timestamp,
        source: "backup"
      })
    }
  }

  checkContentRestored(currentContent) {
    if (!this._contentLossWarningActive || !this._lastSavedContent) return

    const lostChars = this._lastSavedContent.length - currentContent.length
    const lostPercent = this._lastSavedContent.length > 0 ? lostChars / this._lastSavedContent.length : 0

    if (lostPercent <= 0.2 || lostChars <= 50) {
      this.dismissContentLossWarning()
    }
  }

  // === Offline Backup ===

  scheduleOfflineBackup() {
    if (!this.isOffline || !this.currentFile) return

    if (this._offlineBackupTimeout) clearTimeout(this._offlineBackupTimeout)
    this._offlineBackupTimeout = setTimeout(() => {
      this._offlineBackupTimeout = null
      const cm = this.getCodemirrorController()
      const content = cm ? cm.getValue() : ""
      const backup = this.getOfflineBackupController()
      if (backup) backup.save(this.currentFile, content)
    }, 1000)
  }

  // === Auto Save ===

  scheduleAutoSave() {
    if (this.hasPendingRecovery()) return

    this.scheduleDraftWrite()

    if (this.isOffline) {
      this.hasUnsavedChanges = true
      return
    }

    if (this._contentLossWarningActive) {
      this.hasUnsavedChanges = true
      return
    }

    if (!this.hasUnsavedChanges) {
      this.hasUnsavedChanges = true
      this.showSaveStatus(window.t("status.unsaved"))
    }

    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout)
    }

    this.saveTimeout = setTimeout(() => this.saveNow(), this.constructor.SAVE_DEBOUNCE_MS)

    if (!this.saveMaxIntervalTimeout) {
      this.saveMaxIntervalTimeout = setTimeout(() => {
        this.saveMaxIntervalTimeout = null
        if (this.hasUnsavedChanges) {
          this.saveNow()
        }
      }, this.constructor.SAVE_MAX_INTERVAL_MS)
    }
  }

  async saveNow() {
    if (this.hasPendingRecovery()) return

    if (this.isOffline) {
      this.hasUnsavedChanges = true
      return
    }

    if (!this.currentFile) return
    if (this._isSaving) return

    const filePath = this.currentFile
    const fileVersion = this._fileVersion
    this.clearPendingTimers()

    const codemirrorController = this.getCodemirrorController()
    const content = codemirrorController ? codemirrorController.getValue() : ""
    const isConfigFile = filePath === ".fed"
    const savedDraft = this.flushDraftWrite(filePath, content, this._baseRevision)
    const savedDraftRevision = savedDraft.ok ? savedDraft.draft?.draftRevision : null

    if (content === this._lastSavedContent) {
      this.hasUnsavedChanges = false
      this.showSaveStatus("")
      return
    }

    if (this._lastSavedContent && !this._contentLossOverride) {
      const lostChars = this._lastSavedContent.length - content.length
      const lostPercent = lostChars / this._lastSavedContent.length

      if (lostPercent > 0.2 && lostChars > 50) {
        this.showContentLossWarning()
        return
      }
    }

    this._isSaving = true
    try {
      const response = await patch(`/notes/${encodePath(filePath)}`, {
        body: { content },
        responseKind: "json"
      })

      if (!response.ok) {
        throw new Error(window.t("errors.failed_to_save"))
      }

      const responseData = typeof response.json === "function" ? await response.json() : await response.json
      const newRevision = typeof responseData?.revision === "string" ? responseData.revision : null
      if (newRevision) this._knownBaseRevisions.set(filePath, newRevision)

      // Remove only the snapshot captured for this request. A newer edit may
      // already have replaced it while the request was in flight.
      if (savedDraftRevision) this.removeDraftIfRevision(filePath, savedDraftRevision)

      const rebaseNewerDraft = () => {
        if (!newRevision) return
        const latestResult = draftStorage.readDraft(filePath)
        if (!latestResult.ok) {
          if (this.currentFile === filePath) this.showDraftStorageError(latestResult.error)
          return
        }

        const latestDraft = latestResult.draft
        if (latestDraft && latestDraft.content !== content && latestDraft.baseRevision !== newRevision) {
          const rebaseResult = draftStorage.writeDraft(filePath, latestDraft.content, newRevision)
          if (!rebaseResult.ok) {
            if (this.currentFile === filePath) this.showDraftStorageError(rebaseResult.error)
          } else if (this.currentFile === filePath) {
            this._draftRevision = rebaseResult.draft.draftRevision
          }
        }
      }

      rebaseNewerDraft()

      // A rename, delete, or file load may have happened while the request was
      // in flight. Do not let the old response change state for the new file.
      if (this.currentFile !== filePath || this._fileVersion !== fileVersion) {
        if (this.currentFile && this.hasUnsavedChanges) this.scheduleAutoSave()
        return
      }

      this._lastSavedContent = content
      if (newRevision) this._baseRevision = newRevision
      this._lastSaveTime = Date.now()
      this._contentLossOverride = false
      this.hasUnsavedChanges = false
      const backupController = this.getOfflineBackupController()
      if (backupController) backupController.clear(filePath)
      this.showSaveStatus(window.t("status.saved"))
      setTimeout(() => this.showSaveStatus(""), 2000)

      if (isConfigFile) {
        this.dispatch("config-saved")
      }

      const freshContent = codemirrorController ? codemirrorController.getValue() : ""
      if (freshContent !== content) {
        this.hasUnsavedChanges = true
        if (this._baseRevision) this.writeDraftSnapshot({ path: filePath, content: freshContent, baseRevision: this._baseRevision })
        if (!this.isOffline) {
          this.scheduleAutoSave()
        }
      }
    } catch (error) {
      if (this.currentFile !== filePath || this._fileVersion !== fileVersion) {
        if (this.currentFile && this.hasUnsavedChanges) this.scheduleAutoSave()
      } else {
        console.error("Error saving:", error)
        this.showSaveStatus(window.t("status.error_saving"), true)
      }
    } finally {
      this._isSaving = false
    }
  }

  // === Connection Status ===

  onConnectionLost() {
    this.isOffline = true

    // Preserve the latest editor snapshot synchronously before relying on the
    // legacy offline backup path.
    this.flushDraftWrite()

    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout)
      this.saveTimeout = null
      this.hasUnsavedChanges = true
    }
    if (this.saveMaxIntervalTimeout) {
      clearTimeout(this.saveMaxIntervalTimeout)
      this.saveMaxIntervalTimeout = null
    }

    this.dispatch("offline-changed", { detail: { offline: true } })

    this.showSaveStatus(window.t("connection.disconnected"), true)

    if (this.currentFile) {
      const cm = this.getCodemirrorController()
      const content = cm ? cm.getValue() : ""
      const backup = this.getOfflineBackupController()
      if (backup && content && content !== this._lastSavedContent) {
        backup.save(this.currentFile, content)
      }
    }
  }

  onConnectionRestored() {
    this.isOffline = false
    this.showSaveStatus("")

    if (this.hasUnsavedChanges && this.currentFile) {
      this.saveNow()
    }
  }

  // === Content Loss Warning ===

  showContentLossWarning() {
    this._contentLossWarningActive = true
    if (this.hasContentLossBannerTarget) {
      this.contentLossBannerTarget.classList.remove("hidden")
      this.contentLossBannerTarget.classList.add("flex")
    }
  }

  dismissContentLossWarning() {
    this._contentLossWarningActive = false
    this._contentLossOverride = false
    if (this.hasContentLossBannerTarget) {
      this.contentLossBannerTarget.classList.add("hidden")
      this.contentLossBannerTarget.classList.remove("flex")
    }
  }

  undoContentLoss() {
    const codemirrorController = this.getCodemirrorController()
    if (codemirrorController) {
      const view = codemirrorController.getEditorView()
      if (view) {
        undo(view)
      }
    }
    this.dismissContentLossWarning()
  }

  saveAnywayAfterWarning() {
    this.dismissContentLossWarning()
    this._contentLossOverride = true
    this.saveNow()
  }

  // === Recovery ===

  onRecoveryResolved(event) {
    const { source, content, draftRevision, backupContent, backupTimestamp } = event.detail
    const path = this.currentFile
    const removeSelectedBackup = () => {
      if (typeof backupContent !== "string" || !Number.isFinite(backupTimestamp) || !path) return
      const result = draftStorage.removeBackupIfSnapshot(path, backupContent, backupTimestamp)
      if (!result.ok) this.showDraftStorageError(result.error)
    }

    if (draftRevision && path) {
      const latestResult = draftStorage.readDraft(path)
      if (!latestResult.ok) {
        this.showDraftStorageError(latestResult.error)
        return
      }
      if (latestResult.draft && latestResult.draft.draftRevision !== draftRevision) {
        this.showDraftStorageError(new Error("The local draft changed while recovery was open"))
        return
      }
    }

    if (source === "server") {
      if (path && draftRevision) {
        const removal = this.removeDraftIfRevision(path, draftRevision)
        if (!removal.ok) return
      }
      removeSelectedBackup()
      if (draftRevision === this._draftRevision) this._draftRevision = null
      if (this.hasPendingRecovery(path)) this._pendingRecovery = null
      this.hasUnsavedChanges = false
      this.showSaveStatus("")
      return
    }

    if ((source === "backup" || source === "draft") && typeof content === "string") {
      if (this.hasPendingRecovery(path)) this._pendingRecovery = null
      const cm = this.getCodemirrorController()
      if (cm) cm.setValue(content)
      this.clearDraftWriteTimeout(path)
      this.hasUnsavedChanges = true
      this._contentLossOverride = true

      const writeResult = this.flushDraftWrite(path, content, this._baseRevision)
      if (writeResult.ok && writeResult.draft) {
        this._draftRevision = writeResult.draft.draftRevision
        removeSelectedBackup()
      } else if (draftRevision) {
        // Keep the selected source intact if it could not be migrated into the
        // versioned draft store.
        this._draftRevision = draftRevision
      }

      this.scheduleAutoSave()
    }
  }

  // === UI ===

  showSaveStatus(text, isError = false) {
    if (!this.hasSaveStatusTarget) return
    this.saveStatusTarget.textContent = text
    this.saveStatusTarget.classList.toggle("hidden", !text)
    this.saveStatusTarget.classList.toggle("text-red-500", isError)
    this.saveStatusTarget.classList.toggle("dark:text-red-400", isError)
  }

}
