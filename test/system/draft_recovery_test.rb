# frozen_string_literal: true

require "application_system_test_case"

class DraftRecoveryTest < ApplicationSystemTestCase
  test "preserves the outgoing draft when switching files before autosave debounce" do
    create_test_note("a.md", "# Server A")
    create_test_note("b.md", "# Server B")

    visit root_url
    page.execute_script(<<~JS)
      const root = document.querySelector('[data-controller~="app"]')
      const app = window.Stimulus.getControllerForElementAndIdentifier(root, "app")
      app.getAutosaveController().constructor.SAVE_DEBOUNCE_MS = 60000
      app.getAutosaveController().constructor.SAVE_MAX_INTERVAL_MS = 60000
    JS

    find("[data-path='a.md']").click
    assert_equal "# Server A", wait_for_editor_content("# Server A")

    page.execute_script(<<~JS)
      const root = document.querySelector('[data-controller~="app"]')
      const app = window.Stimulus.getControllerForElementAndIdentifier(root, "app")
      app.getCodemirrorController().setValue("# Local draft A")
    JS

    find("[data-path='b.md']").click
    assert_equal "# Server B", wait_for_editor_content("# Server B")
    assert_equal "# Local draft A", JSON.parse(wait_for_browser_draft("a.md"))["content"]

    find("[data-path='a.md']").click
    assert_equal "# Local draft A", wait_for_editor_content("# Local draft A")
    assert_equal "# Server A", @test_notes_dir.join("a.md").read

    page.go_back
    assert_equal "# Server B", wait_for_editor_content("# Server B")
    page.go_back
    assert_equal "# Local draft A", wait_for_editor_content("# Local draft A")
    page.go_back
    assert_selector "[data-app-target='editorPlaceholder']", visible: true

    page.go_forward
    assert_equal "# Local draft A", wait_for_editor_content("# Local draft A")

    page.execute_script(<<~JS)
      const root = document.querySelector('[data-controller~="app"]')
      const app = window.Stimulus.getControllerForElementAndIdentifier(root, "app")
      app.getCodemirrorController().setValue("")
    JS
    find("[data-path='b.md']").click
    assert_equal "# Server B", wait_for_editor_content("# Server B")
    find("[data-path='a.md']").click
    assert_equal "", wait_for_editor_content("")
  end

  test "restores an online unsaved draft after a hard reload" do
    server_content = "# Original note"
    create_test_note("draft.md", server_content)

    visit note_url(path: "draft.md")
    assert_equal server_content, editor_content

    page.execute_script(<<~JS)
      const root = document.querySelector('[data-controller~="app"]')
      const app = window.Stimulus.getControllerForElementAndIdentifier(root, "app")
      const autosave = app.getAutosaveController()
      autosave.constructor.SAVE_DEBOUNCE_MS = 60000
      autosave.constructor.DRAFT_DEBOUNCE_MS = 60000
      app.getCodemirrorController().setValue("# Local draft")
    JS

    key = "frankmd:draft:#{ERB::Util.url_encode('draft.md')}"
    assert_nil page.evaluate_script("localStorage.getItem(#{key.to_json})")
    assert_equal server_content, @test_notes_dir.join("draft.md").read

    page.refresh
    assert_equal "# Local draft", wait_for_editor_content("# Local draft")
    assert_equal server_content, @test_notes_dir.join("draft.md").read
  end

  private

  def wait_for_browser_draft(path)
    key = "frankmd:draft:#{ERB::Util.url_encode(path)}"
    wait_until { page.evaluate_script("localStorage.getItem(#{key.to_json})") }
  end

  def wait_for_editor_content(expected)
    wait_until do
      value = editor_content
      value == expected ? value : nil
    end
  end

  def wait_until
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + Capybara.default_max_wait_time
    loop do
      value = yield
      return value if value
      raise "Timed out waiting for browser state" if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
      sleep 0.05
    end
  end
end
