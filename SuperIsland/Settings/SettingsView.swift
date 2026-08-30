import SwiftUI
import AppKit

enum SettingsPane: String, CaseIterable, Identifiable {
    case general, modules, appearance, extensions, advanced
    var id: String { rawValue }

    var title: String {
        switch self {
        case .general:    "通用"
        case .modules:    "模块"
        case .appearance: "外观"
        case .extensions: "扩展"
        case .advanced:   "高级"
        }
    }

    var icon: String {
        switch self {
        case .general:    "gear"
        case .modules:    "square.grid.2x2"
        case .appearance: "paintbrush"
        case .extensions: "puzzlepiece.extension"
        case .advanced:   "wrench.and.screwdriver"
        }
    }
}

// MARK: - Theme Colors
private let settingsBg    = Color(white: 0.110)   // #1C1C1C — window background
private let settingsCard  = Color(white: 0.163)   // #2A2A2A — card background
private let settingsSel   = Color(white: 0.200)   // #333333 — sidebar selected
private let settingsBorder = Color(white: 1.0, opacity: 0.08)
private let settingsDivider = Color(white: 1.0, opacity: 0.10)

struct SettingsView: View {
    @State private var selectedPane: SettingsPane = .general

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Rectangle()
                .fill(settingsDivider)
                .frame(width: 1)
            contentArea
        }
        .frame(minWidth: 800, idealWidth: 960, minHeight: 560, idealHeight: 680)
        .background(settingsBg)
        .preferredColorScheme(.dark)
    }

    // MARK: - Sidebar

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 1) {
            ForEach(SettingsPane.allCases) { pane in
                sidebarRow(pane)
            }
            Spacer()
            quitRow
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 12)
        .frame(width: 200)
        .background(settingsBg)
    }

    private func sidebarRow(_ pane: SettingsPane) -> some View {
        let isSelected = selectedPane == pane
        return Button {
            selectedPane = pane
        } label: {
            HStack(spacing: 9) {
                Image(systemName: pane.icon)
                    .font(.system(size: 13))
                    .foregroundColor(isSelected ? .primary : .secondary)
                    .frame(width: 18, alignment: .center)
                Text(pane.title)
                    .font(.system(size: 13, weight: isSelected ? .medium : .regular))
                    .foregroundColor(isSelected ? .primary : .secondary)
                Spacer()
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(isSelected ? settingsSel : Color.clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var quitRow: some View {
        Button {
            NSApp.terminate(nil)
        } label: {
            HStack(spacing: 9) {
                Image(systemName: "power")
                    .font(.system(size: 13))
                    .foregroundColor(.secondary)
                    .frame(width: 18, alignment: .center)
                Text("退出")
                    .font(.system(size: 13))
                    .foregroundColor(.secondary)
                Spacer()
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Content Area

    private var contentArea: some View {
        Group {
            if selectedPane == .extensions {
                detailContent
                    .padding(16)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                ScrollView {
                    detailContent
                        .padding(.horizontal, 24)
                        .padding(.vertical, 20)
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                }
                .scrollIndicators(.hidden)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    @ViewBuilder
    private var detailContent: some View {
        switch selectedPane {
        case .general:    GeneralSettingsView()
        case .modules:    ModuleSettingsView()
        case .appearance: AppearanceSettingsView()
        case .extensions: ExtensionsSettingsView()
        case .advanced:   AdvancedSettingsView()
        }
    }
}

// MARK: - Shared Components

struct SettingSectionLabel: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.system(size: 11))
            .foregroundColor(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct SettingGroup<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) {
            content
        }
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(settingsCard)
        )
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(settingsBorder, lineWidth: 1)
        )
    }
}

struct SettingRowDivider: View {
    var body: some View {
        Rectangle()
            .fill(settingsDivider)
            .frame(height: 0.5)
            .padding(.leading, 16)
    }
}

struct SettingToggleRow: View {
    let title: String
    var description: String? = nil
    @Binding var isOn: Bool

    var body: some View {
        HStack(alignment: description != nil ? .top : .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 13))
                if let desc = description {
                    Text(desc)
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            Toggle("", isOn: $isOn).labelsHidden()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
    }
}

struct StepperField: View {
    @Binding var value: Double
    let step: Double
    let range: ClosedRange<Double>
    let label: (Double) -> String

    @State private var text: String = ""
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 0) {
            Button {
                value = max(range.lowerBound, value - step)
            } label: {
                Image(systemName: "minus")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(value <= range.lowerBound)

            TextField("", text: $text)
                .textFieldStyle(.plain)
                .multilineTextAlignment(.center)
                .font(.system(size: 12, design: .monospaced))
                .frame(minWidth: 44)
                .focused($isFocused)
                .onSubmit { commit() }
                .onChange(of: isFocused) { _, focused in
                    if focused {
                        // 聚焦时显示纯数字，便于直接输入
                        text = String(format: "%g", value)
                    } else {
                        commit()
                    }
                }
                .onChange(of: value) { _, newValue in
                    if !isFocused { text = label(newValue) }
                }

            Button {
                value = min(range.upperBound, value + step)
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(value >= range.upperBound)
        }
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(Color(white: 1, opacity: 0.22), lineWidth: 1)
        )
        .onAppear { text = label(value) }
    }

    private func commit() {
        if let parsed = parseNumber(text) {
            value = min(max(parsed, range.lowerBound), range.upperBound)
        }
        text = label(value)
    }

    /// 从用户输入中提取数字（支持 "1.5"、"1,5"、"15pt"、"20%" 等）。
    private func parseNumber(_ input: String) -> Double? {
        let normalized = input.replacingOccurrences(of: ",", with: ".")
        guard let match = normalized.range(
            of: #"-?\d+(\.\d+)?"#,
            options: .regularExpression
        ) else { return nil }
        return Double(normalized[match])
    }
}

// Backward-compat wrapper used by ExtensionsSettingsView
struct SettingsCard<Content: View>: View {
    let title: String
    var subtitle: String? = nil
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 12, weight: .medium))
                if let subtitle {
                    Text(subtitle)
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 12)
            .padding(.bottom, 10)

            Rectangle()
                .fill(settingsDivider)
                .frame(height: 0.5)

            content
                .padding(12)
        }
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(settingsCard)
        )
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(settingsBorder, lineWidth: 1)
        )
    }
}
