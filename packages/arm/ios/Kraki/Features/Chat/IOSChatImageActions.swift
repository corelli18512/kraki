#if os(iOS)
/// Save to Photos and Share for chat images on iOS (viewer toolbar and the
/// long-press menu of a bubble image).

import Photos
import SwiftUI
import UIKit

/// Adds an image to the photo library with add-only access.
protocol ChatPhotoLibrary {
    func authorizationStatus() -> PHAuthorizationStatus
    func requestAuthorization() async -> PHAuthorizationStatus
    func addImage(_ file: ChatImageFile) async throws
}

/// The system photo library.
struct SystemChatPhotoLibrary: ChatPhotoLibrary {
    func authorizationStatus() -> PHAuthorizationStatus {
        PHPhotoLibrary.authorizationStatus(for: .addOnly)
    }

    func requestAuthorization() async -> PHAuthorizationStatus {
        await PHPhotoLibrary.requestAuthorization(for: .addOnly)
    }

    /// The original bytes as the asset's photo resource: a GIF is saved as
    /// a GIF (Photos plays it), never re-encoded to a still JPEG.
    func addImage(_ file: ChatImageFile) async throws {
        try await PHPhotoLibrary.shared().performChanges {
            let options = PHAssetResourceCreationOptions()
            options.originalFilename = file.fileName
            options.uniformTypeIdentifier = file.contentType.identifier
            PHAssetCreationRequest.forAsset().addResource(with: .photo, data: file.data, options: options)
        }
    }
}

enum ChatImageSaveOutcome: Equatable {
    case saved
    /// Photos access was refused (now or earlier) or is restricted.
    case denied
    case failed(String)
}

@MainActor
enum IOSChatImageActions {
    /// The photo library saves go to (a test's fake).
    static var photoLibrary: ChatPhotoLibrary = SystemChatPhotoLibrary()

    /// Asks for add-only access when it was never asked, then saves.
    static func saveToPhotos(_ file: ChatImageFile, library: ChatPhotoLibrary? = nil) async -> ChatImageSaveOutcome {
        let library = library ?? photoLibrary
        var status = library.authorizationStatus()
        if status == .notDetermined { status = await library.requestAuthorization() }
        guard status == .authorized || status == .limited else { return .denied }
        do {
            try await library.addImage(file)
            return .saved
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    /// Saves and tells the user how it went: a short notice, or an alert
    /// that leads to Settings when access was refused.
    static func saveAndReport(_ file: ChatImageFile) {
        Task { @MainActor in
            let outcome = await saveToPhotos(file)
            report(outcome)
        }
    }

    static func report(_ outcome: ChatImageSaveOutcome) {
        guard let top = topViewController() else { return }
        switch outcome {
        case .saved:
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            showNotice(String(localized: "Saved to Photos"), in: top.view)
        case .denied:
            top.present(deniedAlert(), animated: true)
        case .failed(let reason):
            let alert = UIAlertController(
                title: String(localized: "Couldn't Save Image"), message: reason, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: String(localized: "OK"), style: .default))
            top.present(alert, animated: true)
        }
    }

    /// Photos access is off: say so and offer the app's Settings page.
    static func deniedAlert() -> UIAlertController {
        let alert = UIAlertController(
            title: String(localized: "Allow Kraki to Add Photos"),
            message: String(localized: "To save images from chats, allow Kraki to add photos in Settings."),
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: String(localized: "Cancel"), style: .cancel))
        alert.addAction(UIAlertAction(title: String(localized: "Open Settings"), style: .default) { _ in
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        })
        return alert
    }

    /// The share sheet with the original file (real name and type), so
    /// "Save Image", Messages, Files… all get the GIF itself.
    static func share(_ file: ChatImageFile) {
        guard let top = topViewController(), let controller = shareController(file) else { return }
        controller.popoverPresentationController?.sourceView = top.view
        controller.popoverPresentationController?.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 0, height: 0)
        controller.popoverPresentationController?.permittedArrowDirections = []
        top.present(controller, animated: true)
    }

    static func shareController(_ file: ChatImageFile) -> UIActivityViewController? {
        guard let items = shareItems(file) else { return nil }
        let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
        // Shared or cancelled: the temporary copy is no longer needed.
        controller.completionWithItemsHandler = { _, _, _, _ in
            items.forEach(ChatImageFile.removeTemporaryCopy)
        }
        return controller
    }

    /// The image as a file named after it, with its real extension.
    static func shareItems(_ file: ChatImageFile) -> [URL]? {
        (try? file.writeTemporaryCopy()).map { [$0] }
    }

    /// Save to Photos and Share, for a bubble image's long-press menu.
    @ViewBuilder
    static func menuItems(_ file: ChatImageFile) -> some View {
        Button { saveAndReport(file) } label: {
            Label(String(localized: "Save to Photos"), systemImage: "square.and.arrow.down")
        }
        Button { share(file) } label: {
            Label(String(localized: "Share…"), systemImage: "square.and.arrow.up")
        }
    }

    /// The deepest presented controller that is not on its way out.
    static func topViewController() -> UIViewController? {
        let window = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)
        var top = window?.rootViewController
        while let next = top?.presentedViewController, !next.isBeingDismissed { top = next }
        return top
    }

    /// A short-lived capsule near the top of `view`, also announced.
    static func showNotice(_ text: String, in view: UIView) {
        let label = PaddedNoticeLabel()
        label.text = text
        label.font = .systemFont(ofSize: 14, weight: .semibold)
        label.textColor = .white
        label.backgroundColor = UIColor.black.withAlphaComponent(0.78)
        label.layer.cornerRadius = 16
        label.layer.masksToBounds = true
        label.textAlignment = .center
        label.accessibilityIdentifier = "chat-image.notice"
        let size = label.sizeThatFits(CGSize(width: view.bounds.width - 40, height: 60))
        label.frame = CGRect(
            x: (view.bounds.width - size.width) / 2,
            y: view.safeAreaInsets.top + 60,
            width: size.width, height: max(32, size.height)
        )
        label.autoresizingMask = [.flexibleLeftMargin, .flexibleRightMargin, .flexibleBottomMargin]
        view.addSubview(label)
        UIAccessibility.post(notification: .announcement, argument: text)
        UIView.animate(withDuration: 0.25, delay: 1.6, options: [.beginFromCurrentState]) {
            label.alpha = 0
        } completion: { _ in
            label.removeFromSuperview()
        }
    }
}

/// Save to Photos / Share on a long press, once the image's bytes are here.
struct ChatImageContextMenu: ViewModifier {
    let file: ChatImageFile?

    func body(content: Content) -> some View {
        if let file {
            content.contextMenu { IOSChatImageActions.menuItems(file) }
        } else {
            content
        }
    }
}

private final class PaddedNoticeLabel: UILabel {
    private let padding = UIEdgeInsets(top: 7, left: 16, bottom: 7, right: 16)

    override func drawText(in rect: CGRect) {
        super.drawText(in: rect.inset(by: padding))
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        let inner = super.sizeThatFits(CGSize(width: size.width - padding.left - padding.right, height: size.height))
        return CGSize(width: inner.width + padding.left + padding.right, height: inner.height + padding.top + padding.bottom)
    }
}
#endif
