import { Controller } from "@hotwired/stimulus"
import { patch } from "@rails/request.js"
import { encodePath } from "lib/url_utils"
import { undo } from "@codemirror/commands"

export default class extends Controller {
  static targets = ["contentLossBanner", "saveStatus"]
  static outlets = ["codemirror", "offline-backup", "recovery-diff"]

  // Auto-save configuration
  static SAVE_DEBOUNCE_MS = 2000      // Wait 2 seconds after last keystroke
  static SAVE_MAX_INTERVAL_MS = 30000 // Force save every 30 seconds if continuously typing

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
  }

  disconnect() {
    if (this.saveTimeout) clearTimeout(this.saveTimeout)
    if (this.saveMaxIntervalTimeout) clearTimeout(this.saveMaxIntervalTimeout)
    if (this._offlineBackupTimeout) clearTimeout(this._offlineBackupTimeout)
  }

  // === Controller Getters (via Stimulus Outlets) ===

  getCodemirrorController() { return this.codemirrorOutlets[0] ?? null }
  getOfflineBackupController() { return this.offlineBackupOutlets[0] ?? null }
  getRecoveryDiffController() { return this.recoveryDiffOutlets[0] ?? null }

  // === Public API (called by app controller) ===

  setFile(path, content) {
    this.currentFile = path
    this._lastSavedContent = content
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

  checkOfflineBackup(serverContent) {
    const backup = this.getOfflineBackupController()
    if (!backup) return
    const data = backup.check(this.currentFile, serverContent)
    if (!data) return
    const recovery = this.getRecoveryDiffController()
    if (recovery) {
      recovery.open({
        path: this.currentFile,
        serverContent,
        backupContent: data.content,
        backupTimestamp: data.timestamp
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

      // A rename, delete, or file load may have happened while the request was
      // in flight. Do not let the old response change state for the new file.
      if (this.currentFile !== filePath || this._fileVersion !== fileVersion) {
        if (this.currentFile && this.hasUnsavedChanges) this.scheduleAutoSave()
        return
      }

      this._lastSavedContent = content
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
    const { source, content } = event.detail
    const backup = this.getOfflineBackupController()
    if (backup) backup.clear(this.currentFile)

    if (source === "backup" && content) {
      const cm = this.getCodemirrorController()
      if (cm) cm.setValue(content)
      this._lastSavedContent = null
      this.hasUnsavedChanges = true
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
