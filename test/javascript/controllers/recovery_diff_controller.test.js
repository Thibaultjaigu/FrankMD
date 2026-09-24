/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Application } from "@hotwired/stimulus"
import RecoveryDiffController from "../../../app/javascript/controllers/recovery_diff_controller"

describe("RecoveryDiffController", () => {
  let application
  let container
  let controller

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="recovery-diff">
        <dialog data-recovery-diff-target="dialog" data-action="cancel->recovery-diff#preventDismiss">
          <div data-recovery-diff-target="serverText"></div>
          <div data-recovery-diff-target="backupText"></div>
          <span data-recovery-diff-target="backupTimestamp"></span>
          <button data-action="click->recovery-diff#acceptServer">Use Server</button>
          <button data-action="click->recovery-diff#acceptBackup">Restore Backup</button>
        </dialog>
      </div>
    `

    container = document.querySelector('[data-controller="recovery-diff"]')

    application = Application.start()
    application.register("recovery-diff", RecoveryDiffController)

    await new Promise((resolve) => setTimeout(resolve, 10))
    controller = application.getControllerForElementAndIdentifier(container, "recovery-diff")

    // Mock showModal/close since jsdom doesn't support <dialog> fully
    const dialog = container.querySelector("dialog")
    dialog.showModal = vi.fn(function() { this.setAttribute("open", "") })
    dialog.close = vi.fn(function() { this.removeAttribute("open") })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    application.stop()
    document.body.innerHTML = ""
  })

  describe("open()", () => {
    it("computes and renders diff between server and backup content", () => {
      controller.open({
        path: "test.md",
        serverContent: "hello world",
        backupContent: "hello universe",
        backupTimestamp: 1700000000000
      })

      const serverText = container.querySelector('[data-recovery-diff-target="serverText"]')
      const backupText = container.querySelector('[data-recovery-diff-target="backupText"]')

      // Server text should show deletions (word "world" deleted)
      expect(serverText.innerHTML).toContain("ai-diff-del")
      expect(serverText.innerHTML).toContain("world")

      // Backup text should show additions (word "universe" added)
      expect(backupText.innerHTML).toContain("ai-diff-add")
      expect(backupText.innerHTML).toContain("universe")

      // Both should have equal parts
      expect(serverText.innerHTML).toContain("ai-diff-equal")
      expect(backupText.innerHTML).toContain("ai-diff-equal")
    })

    it("formats and displays the backup timestamp", () => {
      const timestamp = new Date(2024, 0, 15, 14, 30, 0).getTime()
      controller.open({
        path: "test.md",
        serverContent: "server",
        backupContent: "backup",
        backupTimestamp: timestamp
      })

      const badge = container.querySelector('[data-recovery-diff-target="backupTimestamp"]')
      // Should contain a formatted date string (locale-dependent)
      expect(badge.textContent).not.toBe("")
    })

    it("opens the dialog", () => {
      const dialog = container.querySelector("dialog")

      controller.open({
        path: "test.md",
        serverContent: "server",
        backupContent: "backup",
        backupTimestamp: Date.now()
      })

      expect(dialog.showModal).toHaveBeenCalled()
    })

    it("prevents Escape from dismissing recovery before an explicit choice", () => {
      const dialog = container.querySelector("dialog")
      controller.open({
        path: "test.md",
        serverContent: "server",
        backupContent: "backup",
        backupTimestamp: Date.now()
      })

      const cancelEvent = new Event("cancel", { cancelable: true })
      dialog.dispatchEvent(cancelEvent)

      expect(cancelEvent.defaultPrevented).toBe(true)
      expect(dialog.open).toBe(true)
      expect(dialog.close).not.toHaveBeenCalled()
    })
  })

  describe("acceptServer()", () => {
    it("dispatches resolved event with source server and closes dialog", () => {
      const dialog = container.querySelector("dialog")
      const dispatchSpy = vi.spyOn(controller, "dispatch")
      const timestamp = Date.now()

      controller.open({
        path: "test.md",
        serverContent: "server",
        backupContent: "backup",
        backupTimestamp: timestamp,
        draftRevision: "draft-1"
      })

      controller.acceptServer()

      expect(dispatchSpy).toHaveBeenCalledWith("resolved", {
        detail: {
          source: "server",
          path: "test.md",
          draftRevision: "draft-1",
          backupContent: "backup",
          backupTimestamp: timestamp
        }
      })
      expect(dialog.close).toHaveBeenCalled()
    })
  })

  describe("acceptBackup()", () => {
    it("dispatches resolved event with source backup and content, then closes", () => {
      const dialog = container.querySelector("dialog")
      const dispatchSpy = vi.spyOn(controller, "dispatch")
      const timestamp = Date.now()

      controller.open({
        path: "test.md",
        serverContent: "server",
        backupContent: "my backup content",
        backupTimestamp: timestamp
      })

      controller.acceptBackup()

      expect(dispatchSpy).toHaveBeenCalledWith("resolved", {
        detail: {
          source: "backup",
          path: "test.md",
          content: "my backup content",
          draftRevision: null,
          backupTimestamp: timestamp
        }
      })
      expect(dialog.close).toHaveBeenCalled()
    })
  })
})
