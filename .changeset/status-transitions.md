---
"@kippurocks/api": minor
---

Seal, cancel and finish (`T-021-09`). `events.seal`, `events.cancel` and `events.finish` change an event's status, releasing an `Active` event's holds and sales first, and `events.cancel` records a refund entitlement per purchased ticket. `events.scheduleFinish`, `events.cancelScheduledFinish` and `events.finishSchedule` schedule a `Finished` with a notice 24 hours before, cancellable until it runs. `StatusChanged`, `ScheduleFinishInput` and `FinishSchedule` are exported.
