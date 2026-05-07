#if os(iOS)
/// NewSessionSheet — Compact glass dialog for creating a new session.
///
/// - Liquid glass material on iOS 26 (translucent floating sheet)
/// - No Cancel button — drag-down to dismiss (system gesture)
/// - Device + Model pickers, plus Reasoning Effort when supported
/// - Initial prompt and working directory are not shown (not used)

import SwiftUI

struct NewSessionSheet: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    @State private var selectedDeviceId: String = ""
    @State private var selectedModel: String = ""
    @State private var reasoningEffort: ReasoningEffort?
    @State private var sessionTitle: String = ""

    private var deviceStore: DeviceStore { appState.deviceStore }

    private var tentacles: [DeviceSummary] {
        deviceStore.tentacleDevices.filter(\.online)
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
        NavigationStack {
            form
                .navigationTitle("New Session")
                .navigationBarTitleDisplayMode(.inline)
                .onAppear { selectDefaults() }
                .onChange(of: selectedDeviceId) { _, _ in onDeviceChanged() }
                .onChange(of: selectedModel) { _, _ in onModelChanged() }
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
        .presentationContentInteraction(.scrolls)
    }

    // MARK: - Form

    @ViewBuilder
    private var form: some View {
        if tentacles.isEmpty {
            noDevicesView
        } else {
            Form {
                Section {
                    TextField("Title (optional)", text: $sessionTitle)
                        .textInputAutocapitalization(.sentences)

                    Picker("Device", selection: $selectedDeviceId) {
                        ForEach(tentacles) { device in
                            Text(device.name).tag(device.id)
                        }
                    }
                    .pickerStyle(.navigationLink)

                    if models.isEmpty {
                        HStack {
                            Text("Model")
                            Spacer()
                            Text("Waiting…")
                                .foregroundStyle(.tertiary)
                        }
                    } else {
                        Picker("Model", selection: $selectedModel) {
                            ForEach(models, id: \.self) { model in
                                Text(model).tag(model)
                            }
                        }
                        .pickerStyle(.navigationLink)
                    }
                }

                if let efforts = supportedEfforts, !efforts.isEmpty {
                    Section("Thinking") {
                        Picker("Reasoning Effort", selection: $reasoningEffort) {
                            ForEach(efforts, id: \.self) { effort in
                                Text(effortLabel(effort)).tag(Optional(effort))
                            }
                        }
                        .pickerStyle(.segmented)
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                createButton
            }
        }
    }

    private var createButton: some View {
        Button {
            createSession()
        } label: {
            Text("Create Session")
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
        }
        .modifier(CreateButtonStyleModifier())
        .tint(.krakiPrimary)
        .disabled(!canSubmit)
        .padding(.horizontal, 20)
        .padding(.bottom, 12)
    }

    private var noDevicesView: some View {
        VStack(spacing: 12) {
            Spacer()
            Text("No devices online")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text("Connect a tentacle to create sessions")
                .font(.caption)
                .foregroundStyle(.tertiary)
            Text("npx @kraki/tentacle")
                .font(.caption2)
                .monospaced()
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Actions

    private func selectDefaults() {
        if selectedDeviceId.isEmpty, let first = tentacles.first {
            selectedDeviceId = first.id
        }
        // Auto-select first model when device's models become available
        let available = deviceStore.deviceModels[selectedDeviceId] ?? []
        if selectedModel.isEmpty || !available.contains(selectedModel) {
            selectedModel = available.first ?? ""
        }
    }

    private func onDeviceChanged() {
        let available = deviceStore.deviceModels[selectedDeviceId] ?? []
        if !available.contains(selectedModel) {
            selectedModel = available.first ?? ""
        }
    }

    private func onModelChanged() {
        guard let detail = selectedModelDetail else {
            reasoningEffort = nil
            return
        }
        if detail.supportsReasoningEffort {
            reasoningEffort = detail.defaultReasoningEffort
        } else {
            reasoningEffort = nil
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

    // MARK: - Helpers

    private func effortLabel(_ effort: ReasoningEffort) -> String {
        switch effort {
        case .low:    return "Low"
        case .medium: return "Medium"
        case .high:   return "High"
        case .xhigh:  return "Max"
        }
    }
}

private struct CreateButtonStyleModifier: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.buttonStyle(.glassProminent)
        } else {
            content.buttonStyle(.borderedProminent)
        }
    }
}

#endif
