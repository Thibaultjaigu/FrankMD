import { Controller } from "@hotwired/stimulus"
import { computeWordDiff } from "lib/diff_utils"
import { escapeHtml } from "lib/text_utils"

export default class extends Controller {
  static targets = ["dialog", "serverText", "backupText", "backupTimestamp"]

  open({ path, serverContent, backupContent, backupTimestamp, source = "backup", draftRevision = null, conflictId = null }) {
    this._path = path
    this._backupContent = backupContent
    this._backupTimestamp = backupTimestamp
    this._source = source
    this._draftRevision = draftRevision
    this._conflictId = conflictId
    this._serverContent = serverContent

    const diff = computeWordDiff(serverContent, backupContent)
    this.serverTextTarget.innerHTML = this.renderDiffOriginal(diff)
    this.backupTextTarget.innerHTML = this.renderDiffCorrected(diff)

    if (this.hasBackupTimestampTarget) {
      const date = new Date(backupTimestamp)
      this.backupTimestampTarget.textContent = date.toLocaleString()
    }

    this.dialogTarget.showModal()
  }

  acceptServer() {
    const detail = {
      source: "server",
      path: this._path,
      draftRevision: this._draftRevision,
      backupContent: this._backupContent,
      backupTimestamp: this._backupTimestamp
    }
    if (this._conflictId) {
      detail.conflictId = this._conflictId
      detail.serverContent = this._serverContent
    }
    this.dispatch("resolved", { detail })
    this.dialogTarget.close()
  }

  acceptBackup() {
    const detail = {
      source: this._source,
      path: this._path,
      content: this._backupContent,
      draftRevision: this._draftRevision,
      backupTimestamp: this._backupTimestamp
    }
    if (this._conflictId) detail.conflictId = this._conflictId
    this.dispatch("resolved", { detail })
    this.dialogTarget.close()
  }

  renderDiffOriginal(diff) {
    let html = ""
    for (const item of diff) {
      const escaped = escapeHtml(item.value)
      if (item.type === "equal") {
        html += `<span class="ai-diff-equal">${escaped}</span>`
      } else if (item.type === "delete") {
        html += `<span class="ai-diff-del">${escaped}</span>`
      }
    }
    return html
  }

  renderDiffCorrected(diff) {
    let html = ""
    for (const item of diff) {
      const escaped = escapeHtml(item.value)
      if (item.type === "equal") {
        html += `<span class="ai-diff-equal">${escaped}</span>`
      } else if (item.type === "insert") {
        html += `<span class="ai-diff-add">${escaped}</span>`
      }
    }
    return html
  }
}
