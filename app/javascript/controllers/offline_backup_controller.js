import { Controller } from "@hotwired/stimulus"
import draftStorage from "lib/draft_storage"

export default class extends Controller {
  save(path, content) {
    const result = draftStorage.writeBackup(path, content)
    if (!result.ok) console.warn("localStorage backup failed:", result.error)
    return result
  }

  check(path, serverContent) {
    const result = draftStorage.readBackup(path)
    if (!result.ok) {
      console.warn("localStorage backup read failed:", result.error)
      return null
    }

    const backup = result.backup
    if (!backup) return null
    if (backup.content === serverContent) {
      this.clear(path)
      return null
    }
    return backup
  }

  clear(path) {
    const result = draftStorage.removeBackup(path)
    if (!result.ok) console.warn("localStorage backup removal failed:", result.error)
    return result
  }

  clearAll() {
    const result = draftStorage.removeAllBackups()
    if (!result.ok) console.warn("localStorage backup removal failed:", result.error)
    return result
  }
}
