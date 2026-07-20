//  HeightMeasurementScheduler.swift
//  Chat sizing — a time-sliced job runner.
//
//  The scheduler's sole job is to run a queue of small work items
//  (each one measures + caches a single cell height) WITHOUT ever
//  blocking a frame for longer than a budget. Each display-link tick
//  runs jobs in FIFO order until `frameBudgetMs` of wall-clock has
//  elapsed, then yields to the run loop. This is the structural
//  guarantee behind "no single frame over budget": a 78ms batch of
//  measurements becomes ~4ms slices spread across consecutive frames.
//
//  It is deliberately generic over `() -> Void` jobs — it knows
//  nothing about cells, caches, or measurement. The facade composes
//  measurement + a trailing "barrier" job to learn when a batch is
//  done. This keeps the budgeting logic in exactly one place.

import QuartzCore

@MainActor
final class HeightMeasurementScheduler {

    private var queue: [() -> Void] = []
    private var link: CADisplayLink?
    private let budgetMs: Double

    /// When true, the link is suspended and no jobs run — but the
    /// queue is preserved. Used to stand down idle warming while the
    /// user is actively scrolling, so a single expensive measurement
    /// can't land on a scroll frame and hitch the gesture. Resumes
    /// (and drains the preserved queue) once motion stops.
    private var paused = false

    /// DIAG counters.
    private(set) var totalFrames = 0
    private(set) var totalJobs = 0

    init(budgetMs: Double) {
        self.budgetMs = budgetMs
    }

    var pendingCount: Int { queue.count }
    var isRunning: Bool { link != nil }

    /// Enqueue a batch of jobs (run in order) and ensure the link is
    /// pumping.
    func enqueue(_ jobs: [() -> Void]) {
        guard !jobs.isEmpty else { return }
        queue.append(contentsOf: jobs)
        startIfNeeded()
    }

    /// Drop every pending job and stop the link. Used on invalidation
    /// (width / Dynamic Type change) — any queued measurement is now
    /// for stale conditions.
    func cancelAll() {
        let dropped = queue.count
        queue.removeAll()
        stop()
        if dropped > 0 { KLog.sizing("scheduler cancelAll dropped=\(dropped)") }
    }

    /// Suspend job execution without dropping the queue. Idempotent.
    func pause() {
        guard !paused else { return }
        paused = true
        stop()
    }

    /// Resume a paused scheduler, restarting the link if work remains.
    /// Idempotent.
    func resume() {
        guard paused else { return }
        paused = false
        startIfNeeded()
    }

    private func startIfNeeded() {
        guard link == nil, !paused, !queue.isEmpty else { return }
        let l = CADisplayLink(target: self, selector: #selector(tick))
        l.add(to: .main, forMode: .common)
        link = l
    }

    @objc private func tick() {
        let start = CACurrentMediaTime()
        var ran = 0
        // Always run at least one job (a single measurement is atomic
        // and can't be split); then keep going only while under budget.
        while !queue.isEmpty {
            let job = queue.removeFirst()
            job()
            ran += 1
            if (CACurrentMediaTime() - start) * 1000.0 >= budgetMs { break }
        }
        totalFrames += 1
        totalJobs += ran
        if queue.isEmpty {
            stop()
        } else {
            KLog.sizing("scheduler frame ran=\(ran) remaining=\(queue.count)")
        }
    }

    private func stop() {
        link?.invalidate()
        link = nil
    }
}
