import SwiftUI
import EventKit

struct CalendarCompactView: View {
    @ObservedObject private var manager = CalendarManager.shared

    var body: some View {
        HStack(spacing: 6) {
            if let event = manager.nextEvent, let countdown = manager.nextEventCountdown {
                Text(event.title ?? "事件")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(.white)
                    .lineLimit(1)

                Text(countdown)
                    .font(.system(size: 10))
                    .foregroundColor(.white.opacity(0.6))
            } else if let event = manager.nextUpcomingEvent {
                Text(event.title ?? "事件")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(.white)
                    .lineLimit(1)

                Text(upcomingDateLabel(for: event))
                    .font(.system(size: 10))
                    .foregroundColor(.white.opacity(0.6))
            } else {
                Text("暂无事件")
                    .font(.system(size: 11))
                    .foregroundColor(.white.opacity(0.5))
            }
        }
    }

    private func upcomingDateLabel(for event: EKEvent) -> String {
        let cal = Calendar.current
        if cal.isDateInTomorrow(event.startDate) { return "明天" }
        if cal.isDate(event.startDate, inSameDayAs: cal.date(byAdding: .day, value: 2, to: Date())!) { return "后天" }

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "M月d日"
        return formatter.string(from: event.startDate)
    }
}
