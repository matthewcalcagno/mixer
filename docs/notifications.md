# Notifications

Use `notification-open` for desktop OS notification clicks. It owns parsing,
process-local deduplication, and startup readiness. Keep navigation in the existing
agent and workspace navigation modules. Senders must not load the React routing
runtime.

Agent payloads name a host and agent. Ignore their workspace hint when opening:
the agent can move after a notification is sent. `navigateToAgent` resolves the
workspace from the current host state. Terminal payloads name their workspace and
use `navigateToWorkspace`.

Notification generation and presence arbitration remain daemon concerns. Delivery
to the desktop client uses its existing session, then the Electron notification
bridge. There is no mobile push transport or token store. Legacy push message
shapes remain accepted at the wire boundary, without sending or storing tokens.

## Startup and verification

Wait for the root navigator, host registry, remembered selection, and startup
redirects before handing off a click. A narrow-window agent route must demand the
host's directory itself; the sidebar can be closed throughout startup.

Verify clicks while the app is visible, hidden, and starting. Include stale and
missing workspace hints and two distinct notifications. Check the focused tab and
the saved workspace layouts, since a foreign pinned tab can survive navigation.
Browser events verify renderer behavior, not Electron window activation or OS
permissions. See [QA](qa.md) for the desktop platform matrix and
[agent targets](expo-router.md#agent-targets) for routing ownership.
