#if os(macOS)
/// Save Image… and Copy Image for chat images on Mac (right-click menu of a
/// bubble image and of the viewer, viewer toolbar).

import AppKit
import UniformTypeIdentifiers

@MainActor
enum MacChatImageActions {
    /// Save Image…: a save panel named after the image with the extension
    /// of its real type; writes the original bytes (a GIF stays animated).
    static func save(_ file: ChatImageFile, window: NSWindow?) {
        let panel = savePanel(for: file)
        let completion: (NSApplication.ModalResponse) -> Void = { response in
            guard response == .OK, let url = panel.url else { return }
            do {
                try write(file, to: url)
            } catch {
                let alert = NSAlert(error: error)
                if let window { alert.beginSheetModal(for: window) } else { alert.runModal() }
            }
        }
        if let window { panel.beginSheetModal(for: window, completionHandler: completion) } else { panel.begin(completionHandler: completion) }
    }

    static func savePanel(for file: ChatImageFile) -> NSSavePanel {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = file.fileName
        panel.allowedContentTypes = [file.contentType]
        panel.isExtensionHidden = false
        panel.canCreateDirectories = true
        return panel
    }

    static func write(_ file: ChatImageFile, to url: URL) throws {
        try file.data.write(to: url, options: .atomic)
    }

    /// Copy Image: the original bytes under their own type (apps that take
    /// GIFs paste the animation), plus TIFF for apps that only take pictures.
    static func copy(_ file: ChatImageFile, to pasteboard: NSPasteboard = .general) {
        let item = NSPasteboardItem()
        item.setData(file.data, forType: NSPasteboard.PasteboardType(file.contentType.identifier))
        if file.contentType != .tiff, let tiff = NSImage(data: file.data)?.tiffRepresentation {
            item.setData(tiff, forType: .tiff)
        }
        pasteboard.clearContents()
        pasteboard.writeObjects([item])
    }

    /// Save Image… and Copy Image, for a right click on an image.
    static func menu(for file: ChatImageFile) -> NSMenu {
        let menu = NSMenu()
        let target = MenuTarget(file: file)
        for (title, action) in [
            (String(localized: "Save Image…"), #selector(MenuTarget.save(_:))),
            (String(localized: "Copy Image"), #selector(MenuTarget.copy(_:))),
        ] {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = target
            // The menu item keeps its (weak) target alive.
            item.representedObject = target
            menu.addItem(item)
        }
        return menu
    }

    @MainActor
    private final class MenuTarget: NSObject {
        let file: ChatImageFile

        init(file: ChatImageFile) {
            self.file = file
        }

        @objc func save(_ sender: NSMenuItem) {
            MacChatImageActions.save(file, window: NSApp.keyWindow ?? NSApp.mainWindow)
        }

        @objc func copy(_ sender: NSMenuItem) {
            MacChatImageActions.copy(file)
        }
    }
}
#endif
