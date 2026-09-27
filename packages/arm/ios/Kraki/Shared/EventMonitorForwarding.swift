/// A missing monitor owner passes an event through; a live owner's nil means
/// CONSUMED. Optional chaining followed by `?? event` conflates these cases.
enum EventMonitorForwarding {
    static func forward<Owner: AnyObject, Event>(
        _ event: Event, owner: Owner?, intercept: (Owner, Event) -> Event?
    ) -> Event? {
        guard let owner else { return event }
        return intercept(owner, event)
    }
}
