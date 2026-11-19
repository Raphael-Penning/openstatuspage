# Daily work: incidents and maintenance

Editors and administrators communicate with customers through **incidents**
(unplanned disruptions) and **maintenance** (planned work). Both appear on the
public page, in the history, in the RSS/Atom feeds and, if enabled, in
[subscriber emails](07-email-subscriptions.md).

Times are entered in your browser's time zone (shown below the date fields)
and stored in UTC.

## Incidents

### Reporting an incident

**Incidents → New incident**:

| Field | Notes |
| --- | --- |
| Title | Short and understandable for customers, e.g. "Increased error rates for the API". |
| Status | *Investigating*, *Identified*, *Monitoring* or *Resolved*. |
| Impact | Overall severity shown on the incident (none, minor, major, critical). |
| Message | The first public update. Keep it short and factual. |
| Affected services | Pick the services and how badly each one is affected (e.g. *Partial outage*). |
| Affected locations | Optional: related data center locations. |
| Started | When the disruption began; defaults to now. |
| Visible on the public status page | Hidden incidents are only visible in the management UI and do not change public statuses. |
| Notify subscribers | Sends an email to matching subscribers (default on, only for public incidents). |

While the incident is unresolved, each affected service shows at least the
status you selected for it. If several incidents affect a service, the worst
status wins.

### Keeping customers informed

Open the incident and use **Post update**. Every update has a status and a
message and appears in the public timeline. With **Adjust affected services**
you can change the affected services and their status in the same step, for
example when an outage turns into degraded performance.

Good practice:

- Post the first update early, even if the cause is unknown.
- Say what customers notice, not what is broken internally. Do not mention
  host names, internal systems or monitoring details.
- Post updates at regular intervals and announce when the next one follows.

Existing updates can be edited or deleted (an incident keeps at least one
update). Edits do not send emails.

### Resolving

Post an update with status **Resolved**, or use **Resolve**. The incident
closes, the services return to their monitored status, and the incident
stays in the public history. Posting a non-resolved update later re-opens it.

Deleting an incident removes it from the public history completely. Prefer
resolving; delete only test entries or mistakes.

## Maintenance

### Scheduling

**Maintenance → Schedule maintenance**:

| Field | Notes |
| --- | --- |
| Title, Description | Public. Describe what happens and what customers should expect. |
| Scheduled start / end | The maintenance window. |
| Start automatically | Switches to *In progress* at the scheduled start. |
| Complete automatically | Switches to *Completed* at the scheduled end. |
| Affected services | Show *Maintenance* while the window is in progress. |
| Affected locations | Optional. |
| Visible on the public status page | Hidden maintenance does not appear publicly and does not change statuses. |
| Notify subscribers | Announces the maintenance by email and is **remembered** for later notifications (see below). |

Upcoming maintenance is listed on the public overview. A window that starts
now (or within the last few minutes) is started right away. Windows that
started or ended earlier are entered retroactively, see
[Correcting the history](#correcting-the-history).

### Automatic start and completion

The background worker checks every 30 seconds whether a window has started or
ended and switches the status for maintenance with *Start automatically* /
*Complete automatically*. These automatic updates have no text of their own;
the public page and the emails show a standard sentence such as "The
maintenance has started."

Automatic transitions require a running worker (`WORKER_ENABLED=true` on one
instance, the default). You can always switch by hand with **Start now**,
**Complete** or **Cancel maintenance**, or by posting an update with a status.

While a public maintenance is in progress, its services show *Maintenance*,
even if their checks fail. That is the intended way to hide planned
interruptions from the check-based status.

### Changing and cancelling

**Edit maintenance** changes title, description, window, services,
visibility and the stored **Notify subscribers** choice. Saving it sends no
email. To move a maintenance, change the window (moved to a later start,
subscribers get a new reminder); to call it off, use
**Cancel maintenance** so customers see that it will not happen. Deleting
removes it completely.

## Correcting the history

The uptime bars are calculated from the status the monitoring recorded. When
that record is wrong, you correct it afterwards. Corrections are a layer on
top of the recorded data: the recorded data is never changed, so every
correction can be edited or deleted again and the uptime is recalculated
right away. Every correction is written to the audit log.

### Fixing a forgotten maintenance

Example: yesterday you upgraded a switch, forgot to enter the maintenance,
and the monitoring recorded the time as an outage.

1. **Maintenance → Schedule maintenance**.
2. Enter the **real** window (start and end in the past) and the affected
   services, as for any maintenance.
3. The form says that the window is already over. Save with
   **Record maintenance**.

The maintenance is created as *Completed* with its timeline (started,
completed) at the real times and is marked *Entered afterwards*. For its
services the window counts as *Maintenance*, no longer as an outage, in the
uptime bars and percentages. A public maintenance appears in the public
history like any other. **No email is sent** for a window that is already
over, and no reminder either. As everywhere, a **hidden** maintenance does
not change statuses, so it does not correct the uptime either. To correct an
internal window without listing it publicly, use a status correction with the
status *Maintenance* instead (see below).

If the window has started but is not over yet (e.g. you are in the middle of
the work), it starts immediately: subscribers get only the "in progress"
email, no announcement, and the time since the start counts as
maintenance. Changing the window of such a maintenance later corrects the
history accordingly; deleting it removes the correction. If you move its end
into the past, it is completed right away at that end, without an email.

### Marking a false alarm or a missed outage

**Corrections → New correction** sets the status of one or more services for
a past time range:

| Field | Notes |
| --- | --- |
| Services | One or more services. |
| Start / End | The time range. The end must not be in the future. |
| Status | *Operational* for a false alarm (e.g. the monitoring host lost its network). An outage status records an outage the monitoring missed. |
| Reason | Required. Internal only: never shown publicly, recorded in the audit log. |
| Show a note on the public page | Per correction: days containing it are marked *Corrected afterwards* on the public page (in the uptime bar tooltip and on the service page). |
| Public note | Optional text shown with the marker, e.g. "False alarm of the monitoring system." |

Without the public note option, the corrected uptime is shown without any
marker. Where corrections overlap, the one **created last** wins; a
correction also wins over a retroactive maintenance. A day is only marked
publicly where a public correction is still in effect: if a newer internal
correction covers it completely, the marker disappears. Deleting a service
also deletes corrections that apply only to that service. The list can be filtered
by service and date.

To check the effect, open the service (**Services & sites**) and scroll to
**History: measured and corrected**: it compares the measured with the
corrected status and uptime for a date range and lists the corrected
periods. **Add correction** opens a new correction for the shown range.

Corrections only change the history. They do not change the current status
of a service and send no email; for something that is happening now, use an
incident or a maintenance.

## The "Notify subscribers" checkbox

Every form that creates an incident or maintenance or posts an update has a
**Notify subscribers** checkbox: **New incident**, **Post update**,
**Resolve**, **Schedule maintenance**, **Start now**, **Complete** and
**Cancel maintenance**. It is on by default.

- Only **public** incidents and maintenance ever send emails. Hidden ones
  never do, whatever the checkbox says.
- Emails are only sent while email subscriptions are enabled in the settings
  (**Offer email subscriptions**).
- For incidents and for manual updates the checkbox applies to that one step:
  untick it for small corrections or internal-sounding updates.
- For maintenance the choice is **stored** with the maintenance. It controls
  the announcement and also the automatic emails later on: the
  [reminder](07-email-subscriptions.md#maintenance-reminders) before the
  window and the automatic start and completion. Untick it when you schedule
  a maintenance nobody needs to be told about; you can change the stored
  choice later in **Edit maintenance** (that alone sends nothing). The
  maintenance detail page shows the stored choice and when the reminder was
  queued; a maintenance without notifications is marked
  *No email notifications*.
- Editing an incident, a maintenance or an existing update never sends an
  email.

Who receives the email depends on the affected services, see
[Email subscriptions](07-email-subscriptions.md#who-receives-what).

## Roles

Editors may create and change incidents, maintenance and corrections and
read everything else. Services, groups, locations, monitoring, settings, users and API tokens
are managed by administrators; see [Users and access](08-users-and-access.md).
