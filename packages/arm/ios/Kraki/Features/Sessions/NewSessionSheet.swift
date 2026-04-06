#if os(iOS)
/// NewSessionSheet — Modal sheet for creating a new session.
///
/// Mirrors NewSessionDialog.tsx:
/// - Device picker (tentacle devices only)
/// - Model picker from selected device's capabilities
/// - Reasoning effort picker (when model supports it)
/// - Optional initial prompt and working directory
/// - Create button → calls commandSender.createSession()

import SwiftUI

struct NewSessionSheet: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    @State private var selectedDeviceId: String = ""
    @State private var selectedModel: String = ""
    @State private var reasoningEffort: ReasoningEffort?
    @State private var initialPrompt: String = ""
    @State private var workingDirectory: String = ""

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
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                }
                .onAppear { selectDefaults() }
                .onChange(of: selectedDeviceId) { _, _ in onDeviceChanged() }
                .onChange(of: selectedModel) { _, _ in onModelChanged() }
        }
    }

    // MARK: - Form

    private var form: some View {
        Form {
            if tentacles.isEmpty {
                noDevicesSection
            } else {
                deviceSection
                modelSection

                if let efforts = supportedEfforts, !efforts.isEmpty {
                    effortSection(efforts)
                }

                promptSection
                cwdSection
                createButton
            }
        }
    }

    // MARK: - Sections

    private var noDevicesSection: some View {
        Section {
            VStack(spacing: 8) {
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
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 20)
        }
    }

    private var deviceSection: some View {
        Section("Device") {
            Picker("Device", selection: $selectedDeviceId) {
                Text("Select a device").tag("")
                ForEach(tentacles) { device in
                    HStack(spacing: 6) {
                        Circle()
                            .fill(device.online ? Color.green : Color.gray)
                            .frame(width: 6, height: 6)
                        Text(device.name)
                    }
                    .tag(device.id)
                }
            }
            .pickerStyle(.menu)
        }
    }

    private var modelSection: some View {
        Section("Model") {
            if models.isEmpty {
                if selectedDeviceId.isEmpty {
                    Text("Select a device first")
                        .font(.subheadline)
                        .foregroundStyle(.tertiary)
                } else {
                    TextField("e.g. claude-sonnet-4", text: $selectedModel)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
            } else {
                Picker("Model", selection: $selectedModel) {
                    Text("Select a model").tag("")
                    ForEach(models, id: \.self) { model in
                        Text(model).tag(model)
                    }
                }
                .pickerStyle(.menu)
            }
        }
    }

    private func effortSection(_ efforts: [ReasoningEffort]) -> some View {
        Section("Thinking") {
            Picker("Reasoning Effort", selection: $reasoningEffort) {
                ForEach(efforts, id: \.self) { effort in
                    Text(effortLabel(effort)).tag(Optional(effort))
                }
            }
            .pickerStyle(.segmented)
        }
    }

    private var promptSection: some View {
        Section {
            TextEditor(text: $initialPrompt)
                .frame(minHeight: 80)
                .textInputAutocapitalization(.sentences)
        } header: {
            Text("Initial Prompt")
        } footer: {
            Text("Optional. Send an initial message when the session starts.")
        }
    }

    private var cwdSection: some View {
        Section {
            TextField("/path/to/project", text: $workingDirectory)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.body.monospaced())
        } header: {
            Text("Working Directory")
        } footer: {
            Text("Optional. The working directory for the agent on the device.")
        }
    }

    private var createButton: some View {
        Section {
            Button {
                createSession()
            } label: {
                Text("Create Session")
                    .frame(maxWidth: .infinity)
                    .fontWeight(.semibold)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!canSubmit)
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
        }
    }

    // MARK: - Actions

    private func selectDefaults() {
        guard selectedDeviceId.isEmpty else { return }
        if let first = tentacles.first {
            selectedDeviceId = first.id
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
        appState.commandSender?.createSession(
            targetDeviceId: selectedDeviceId,
            model: selectedModel,
            reasoningEffort: reasoningEffort,
            prompt: initialPrompt.isEmpty ? nil : initialPrompt,
            cwd: workingDirectory.isEmpty ? nil : workingDirectory
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

#endif
