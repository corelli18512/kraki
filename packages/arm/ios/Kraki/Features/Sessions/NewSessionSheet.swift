#if os(iOS)
/// NewSessionSheet — Compact glass dialog for creating a new session.
///
/// Design language: **Crossfade replace** (Apple Music / Wallet style).
/// - Fixed `.height(360)` detent — no sheet resize, glass preserved.
/// - Tap a row → form content crossfades to the picker for that field,
///   filling the same area. Back chevron + title at top.
/// - No NavigationStack push, no popover, no detent change ⇒ no flicker.
/// - Liquid glass material on the floating card via `.glassEffect`.

import SwiftUI

struct NewSessionSheet: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    @State private var selectedDeviceId: String = ""
    @State private var selectedModel: String = ""
    @State private var reasoningEffort: ReasoningEffort?
    @State private var sessionTitle: String = ""
    @State private var screen: Screen = .form
    @State private var showImportSheet: Bool = false

    private enum Screen: Equatable {
        case form
        case devicePicker
        case modelPicker
    }

    private var deviceStore: DeviceStore { appState.deviceStore }

    private var tentacles: [DeviceSummary] {
        deviceStore.tentacleDevices
    }

    private var onlineTentacles: [DeviceSummary] {
        tentacles.filter(\.online)
    }

    private var models: [String] {
        deviceStore.deviceModels[selectedDeviceId] ?? []
    }

    private var modelDetails: [ModelDetail] {
        deviceStore.deviceModelDetails[selectedDeviceId] ?? []
    }

    private var selectedModelDetail: ModelDetail? {
        modelDetails.first { $0.id == selectedModel }
    }

    private var supportedEfforts: [ReasoningEffort]? {
        guard let detail = selectedModelDetail,
              detail.supportsReasoningEffort else { return nil }
        return detail.supportedReasoningEfforts
    }

    private var canSubmit: Bool {
        !selectedDeviceId.isEmpty && !selectedModel.isEmpty
    }

    // MARK: - Body

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 20)
                .padding(.top, 24)
                .padding(.bottom, 12)

            if tentacles.isEmpty {
                noDevicesView
            } else {
                ZStack {
                    switch screen {
                    case .form:
                        formCard
                            .transition(.opacity.combined(with: .scale(scale: 0.97)))
                    case .devicePicker:
                        devicePickerCard
                            .transition(.opacity.combined(with: .scale(scale: 0.97)))
                    case .modelPicker:
                        modelPickerCard
                            .transition(.opacity.combined(with: .scale(scale: 0.97)))
                    }
                }
                .animation(.easeInOut(duration: 0.22), value: screen)
                .padding(.horizontal, 16)
                .padding(.top, 16)

                Spacer(minLength: 0)

                createButton
            }
        }
        .presentationDetents([.height(360)])
        .presentationDragIndicator(.hidden)
        .presentationBackground(.clear)
        .onAppear { selectDefaults() }
        .onChange(of: selectedDeviceId) { _, _ in onDeviceChanged() }
        .onChange(of: selectedModel) { _, _ in onModelChanged() }
        .sheet(isPresented: $showImportSheet) {
            ImportSessionSheet()
                .environment(appState)
        }
    }

    // MARK: - Header

    @ViewBuilder
    private var header: some View {
        if screen == .form {
            HStack(spacing: 12) {
                Text("New Session")
                    .font(.title2.weight(.semibold))
                Spacer()
                // Import button hidden for the v1 launch — the
                // underlying `ImportSessionSheet` + `showImportSheet`
                // state is intentionally kept intact so we can
                // re-enable the entry point by flipping this flag
                // back to `true` once the import flow ships.
                if false {
                    Button {
                        showImportSheet = true
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "square.and.arrow.down")
                                .font(.subheadline.weight(.medium))
                            Text("Import")
                                .font(.subheadline.weight(.medium))
                        }
                        .foregroundStyle(Color.krakiPrimary)
                    }
                    .buttonStyle(.plain)
                }
            }
        } else {
            HStack(spacing: 8) {
                Button {
                    goBack()
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Color.krakiPrimary)
                        .padding(.trailing, 4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Text(screen == .devicePicker ? "Device" : "Model")
                    .font(.title2.weight(.semibold))
                Spacer()
            }
        }
    }

    private func goBack() {
        withAnimation(.easeInOut(duration: 0.22)) {
            screen = .form
        }
    }

    // MARK: - Form Card

    private var formCard: some View {
        VStack(spacing: 0) {
            rowButton(label: "Device",
                      value: tentacles.first(where: { $0.id == selectedDeviceId })?.name ?? "Select") {
                withAnimation(.easeInOut(duration: 0.22)) { screen = .devicePicker }
            }

            Divider().padding(.leading, 16)

            if models.isEmpty {
                HStack {
                    Text("Model").foregroundStyle(Color.primary)
                    Spacer()
                    Text("Waiting…").foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
            } else {
                rowButton(label: "Model",
                          value: selectedModel.isEmpty ? "Select" : selectedModel) {
                    withAnimation(.easeInOut(duration: 0.22)) { screen = .modelPicker }
                }
            }

            Divider().padding(.leading, 16)

            HStack {
                Text("Title").foregroundStyle(Color.primary)
                TextField("Optional", text: $sessionTitle)
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.sentences)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
        }
        .modifier(GlassCardModifier())
    }

    private func rowButton(label: String, value: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(label).foregroundStyle(Color.primary)
                Spacer()
                Text(value).foregroundStyle(.secondary)
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Picker Card

    private var devicePickerCard: some View {
        AlwaysScrollableArea {
            VStack(spacing: 0) {
                ForEach(Array(tentacles.enumerated()), id: \.element.id) { index, device in
                    Button {
                        guard device.online else { return }
                        selectedDeviceId = device.id
                        SessionPrefs.saveLastDevice(device.id)
                        goBack()
                    } label: {
                        HStack(spacing: 10) {
                            Circle()
                                .fill(device.online ? Color.green : Color.gray)
                                .frame(width: 7, height: 7)
                            Text(device.name)
                                .foregroundStyle(device.online ? Color.primary : Color.secondary)
                            Spacer()
                            if device.id == selectedDeviceId {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(Color.krakiPrimary)
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!device.online)

                    if index < tentacles.count - 1 {
                        Divider().padding(.leading, 16)
                    }
                }
            }
        }
        .modifier(GlassCardModifier())
    }

    private var modelPickerCard: some View {
        AlwaysScrollableArea {
            ModelPickerCard(
                models: models,
                modelDetails: modelDetails,
                selectedModel: selectedModel,
                reasoningEffort: $reasoningEffort,
                onSelect: { model in
                    selectedModel = model
                    SessionPrefs.saveLastModel(deviceId: selectedDeviceId, model: model)
                    // Don't auto-back so user can tweak Thinking.
                },
                onEffortChange: { effort in
                    SessionPrefs.saveLastEffort(model: selectedModel, effort: effort)
                }
            )
        }
    }

    // MARK: - Create / Empty

    private var createButton: some View {
        Button {
            createSession()
        } label: {
            Text("Create")
                .font(.body.weight(.semibold))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(canSubmit ? Color.krakiPrimary : Color.krakiPrimary.opacity(0.4), in: Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!canSubmit)
        .padding(.horizontal, 40)
        .padding(.bottom, 12)
        .padding(.top, 8)
    }

    /// Static help URL. Both candidates are well-formed RFC 3986
    /// strings the compiler accepts at build time; the fallback
    /// chain avoids a force-unwrap entirely in case Swift's URL
    /// parser ever tightens up around either string.
    private static let helpURL: URL = {
        if let u = URL(string: "https://github.com/corelli18512/kraki#readme") { return u }
        if let u = URL(string: "https://kraki.chat") { return u }
        // Last resort: an empty URL never traversed. Link wraps this
        // with a Tap action that just won't open; we'd rather show
        // a dead link than crash launch.
        return URL(fileURLWithPath: "/")
    }()

    private var noDevicesView: some View {
        VStack(spacing: 12) {
            Spacer()
            Text("No devices online").font(.title3).foregroundStyle(.secondary)
            Text("Connect a tentacle to create sessions").font(.subheadline).foregroundStyle(.tertiary)
            Link("How?", destination: Self.helpURL)
                .font(.subheadline)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Actions

    private func selectDefaults() {
        if selectedDeviceId.isEmpty {
            // Prefer the last-used device if it's still online; otherwise first online.
            if let lastId = SessionPrefs.lastDeviceId(),
               let lastOnline = onlineTentacles.first(where: { $0.id == lastId }) {
                selectedDeviceId = lastOnline.id
            } else if let first = onlineTentacles.first {
                selectedDeviceId = first.id
            }
        }
        applyModelPref()
    }

    private func onDeviceChanged() {
        applyModelPref()
    }

    /// Restore the last model selected for the current device, or auto-pick
    /// the first available if the saved model is gone.
    private func applyModelPref() {
        let available = deviceStore.deviceModels[selectedDeviceId] ?? []
        guard !available.isEmpty else { return }
        if let lastModel = SessionPrefs.lastModel(deviceId: selectedDeviceId),
           available.contains(lastModel) {
            selectedModel = lastModel
        } else if selectedModel.isEmpty || !available.contains(selectedModel) {
            selectedModel = available.first ?? ""
        }
    }

    private func onModelChanged() {
        guard let detail = selectedModelDetail else {
            reasoningEffort = nil
            return
        }
        guard detail.supportsReasoningEffort,
              let efforts = detail.supportedReasoningEfforts,
              !efforts.isEmpty else {
            reasoningEffort = nil
            return
        }
        // Restore last effort for this model, else fall back to the model's default.
        if let lastEffort = SessionPrefs.lastEffort(model: selectedModel),
           efforts.contains(lastEffort) {
            reasoningEffort = lastEffort
        } else {
            reasoningEffort = detail.defaultReasoningEffort
        }
    }

    private func createSession() {
        guard canSubmit else { return }
        let trimmed = sessionTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        appState.commandSender?.createSession(
            targetDeviceId: selectedDeviceId,
            model: selectedModel,
            reasoningEffort: reasoningEffort,
            prompt: nil,
            cwd: nil,
            title: trimmed.isEmpty ? nil : trimmed
        )
        dismiss()
    }

    private func effortLabel(_ effort: ReasoningEffort) -> String {
        switch effort {
        case .low:    return "Low"
        case .medium: return "Medium"
        case .high:   return "High"
        case .xhigh:  return "Max"
        }
    }
}

/// Visual card showing one model per row with a leading checkmark on the
/// current selection and an inline "Thinking" segmented control under it
/// when the model supports reasoning effort. Shared by NewSessionSheet
/// (new session form) and SessionInfoSheet (live model switch).
struct ModelPickerCard: View {
    let models: [String]
    let modelDetails: [ModelDetail]
    let selectedModel: String
    @Binding var reasoningEffort: ReasoningEffort?
    /// Fired when the user taps a model row.
    let onSelect: (String) -> Void
    /// Fired when the user picks a reasoning effort for the current model.
    /// Optional — NewSessionSheet uses it to persist the last-used effort.
    var onEffortChange: ((ReasoningEffort) -> Void)? = nil

    private func supportedEfforts(for model: String) -> [ReasoningEffort]? {
        guard let detail = modelDetails.first(where: { $0.id == model }),
              detail.supportsReasoningEffort else { return nil }
        return detail.supportedReasoningEfforts
    }

    private func effortLabel(_ effort: ReasoningEffort) -> String {
        switch effort {
        case .low:    return "Low"
        case .medium: return "Medium"
        case .high:   return "High"
        case .xhigh:  return "Max"
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(models.enumerated()), id: \.element) { index, model in
                Button {
                    onSelect(model)
                } label: {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text(model).foregroundStyle(Color.primary)
                            Spacer()
                            if model == selectedModel {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(Color.krakiPrimary)
                            }
                        }
                        if model == selectedModel,
                           let efforts = supportedEfforts(for: model),
                           !efforts.isEmpty {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Thinking")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                ThinkingSegmentedControl(
                                    titles: efforts.map(effortLabel),
                                    selection: Binding(
                                        get: { efforts.firstIndex(of: reasoningEffort ?? efforts[0]) ?? 0 },
                                        set: {
                                            let effort = efforts[$0]
                                            reasoningEffort = effort
                                            onEffortChange?(effort)
                                        }
                                    ),
                                    tintColor: UIColor(Color.krakiPrimary)
                                )
                            }
                            .padding(.top, 2)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if index < models.count - 1 {
                    Divider().padding(.leading, 16)
                }
            }
        }
        .modifier(GlassCardModifier())
    }
}

struct GlassCardModifier: ViewModifier {
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: 16, style: .continuous)
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular, in: shape)
        } else {
            content.background(.ultraThinMaterial, in: shape)
        }
    }
}

/// Persists the user's last-used Device / Model / Reasoning-Effort choices,
/// mirroring the web `NewSessionDialog` keys so the same prefs would
/// conceptually carry across surfaces.
enum SessionPrefs {
    private static let lastDeviceKey = "kraki:last-device"
    private static let lastModelKey  = "kraki:last-model"   // { deviceId: model }
    private static let lastEffortKey = "kraki:last-effort"  // { model: effort }

    static func lastDeviceId() -> String? {
        UserDefaults.standard.string(forKey: lastDeviceKey)
    }

    static func saveLastDevice(_ id: String) {
        UserDefaults.standard.set(id, forKey: lastDeviceKey)
    }

    static func lastModel(deviceId: String) -> String? {
        modelMap()[deviceId]
    }

    static func saveLastModel(deviceId: String, model: String) {
        var map = modelMap()
        map[deviceId] = model
        UserDefaults.standard.set(map, forKey: lastModelKey)
    }

    static func lastEffort(model: String) -> ReasoningEffort? {
        guard let raw = effortMap()[model] else { return nil }
        return ReasoningEffort(rawValue: raw)
    }

    static func saveLastEffort(model: String, effort: ReasoningEffort) {
        var map = effortMap()
        map[model] = effort.rawValue
        UserDefaults.standard.set(map, forKey: lastEffortKey)
    }

    private static func modelMap() -> [String: String] {
        UserDefaults.standard.dictionary(forKey: lastModelKey) as? [String: String] ?? [:]
    }

    private static func effortMap() -> [String: String] {
        UserDefaults.standard.dictionary(forKey: lastEffortKey) as? [String: String] ?? [:]
    }
}

/// Native UISegmentedControl wrapped for SwiftUI so the selected segment
/// can be reliably tinted with the app's theme color. SwiftUI's
/// `Picker(.segmented) + .tint()` doesn't paint the selected pill on iOS 26.
struct ThinkingSegmentedControl: UIViewRepresentable {
    let titles: [String]
    @Binding var selection: Int
    let tintColor: UIColor

    func makeUIView(context: Context) -> UISegmentedControl {
        let control = UISegmentedControl(items: titles)
        control.selectedSegmentIndex = selection
        control.selectedSegmentTintColor = tintColor
        control.setTitleTextAttributes([.foregroundColor: UIColor.white], for: .selected)
        control.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .valueChanged)
        return control
    }

    func updateUIView(_ control: UISegmentedControl, context: Context) {
        if control.selectedSegmentIndex != selection {
            control.selectedSegmentIndex = selection
        }
        control.selectedSegmentTintColor = tintColor
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject {
        let parent: ThinkingSegmentedControl
        init(_ parent: ThinkingSegmentedControl) { self.parent = parent }
        @objc func changed(_ control: UISegmentedControl) {
            parent.selection = control.selectedSegmentIndex
        }
    }
}

/// Scrollable container with a custom always-visible scrollbar.
///
/// SwiftUI's `.scrollIndicators(.visible)` still auto-hides on iOS, so we
/// track scroll geometry via iOS 18's `onScrollGeometryChange` and draw a
/// thin capsule on the trailing edge whenever content overflows.
private struct AlwaysScrollableArea<Content: View>: View {
    let content: Content
    @State private var contentHeight: CGFloat = 0
    @State private var viewportHeight: CGFloat = 0
    @State private var offset: CGFloat = 0

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        ScrollView {
            content
        }
        .scrollIndicators(.hidden)
        .onScrollGeometryChange(for: ScrollMetrics.self) { geo in
            ScrollMetrics(
                content: geo.contentSize.height,
                viewport: geo.containerSize.height,
                offset: geo.contentOffset.y
            )
        } action: { _, new in
            contentHeight = new.content
            viewportHeight = new.viewport
            offset = new.offset
        }
        .overlay(alignment: .topTrailing) {
            if contentHeight > viewportHeight + 1, viewportHeight > 0 {
                scrollThumb
                    .padding(.trailing, 3)
                    .transition(.opacity)
            }
        }
    }

    private var scrollThumb: some View {
        let ratio = max(0.05, min(1.0, viewportHeight / contentHeight))
        let thumbHeight = max(28, viewportHeight * ratio)
        let maxScroll = max(contentHeight - viewportHeight, 1)
        let t = min(max(offset / maxScroll, 0), 1)
        let y = t * (viewportHeight - thumbHeight)
        return Capsule()
            .fill(Color.primary.opacity(0.25))
            .frame(width: 3, height: thumbHeight)
            .offset(y: y)
    }
}

private struct ScrollMetrics: Equatable {
    var content: CGFloat
    var viewport: CGFloat
    var offset: CGFloat
}

#endif
