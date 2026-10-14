# Connecting Gmail and Google Calendar (read-only)

About 10 minutes, once. Nothing here costs money. The connectors are **read-only**:

| Service | Scope requested | What the app can see | What it can never see or do |
|---|---|---|---|
| Gmail | `gmail.readonly` | Sender, subject, date and labels of your 25 latest inbox messages are synced. A message's text is read **on demand**, only to draft a reply, processed by your **local** model and **never stored** | Attachments; it cannot send, delete or modify anything (read-only scope) |
| Google Calendar | `calendar.events.readonly` | Title, start/end, location of events from yesterday to +14 days | Descriptions, attendees; it cannot create or change events |

Optional third service, **Gmail drafts**, if you want approved replies to appear in your Gmail *Drafts* folder:

| Service | Scope requested | What the app does with it |
|---|---|---|
| Gmail drafts | `gmail.compose` | Creates a reply draft in the right thread **after you approve its exact text**. You send it yourself from Gmail |
| Google Calendar: app calendar | `calendar.app.created` | Creates one calendar named “Agent Command Center” and adds the events you approve to it. Google limits this scope to calendars the app created: it can't see or change your own calendars |

> **Be aware:** Google has no "drafts only" scope. `gmail.compose` also permits *sending* at Google's level. The app contains that in code: the only call this token can make is `POST /gmail/v1/users/me/drafts` (enforced, and asserted by tests), it never reads mail, every draft needs your approval, and it's a separate connection you can revoke without touching read-only Gmail. If that trade-off doesn't suit you, simply don't connect it; everything else works without it.

Connecting a service does **not** give agents access: both the service and each agent stay at **None** until you raise them in *Connections & Permissions*.

## 1. Create a Google Cloud project

1. Open <https://console.cloud.google.com/> and create a project (e.g. `agent-command-center`).
2. **APIs & Services → Library**: enable **Gmail API** and **Google Calendar API**.

## 2. Configure the consent screen (Google Auth Platform)

1. **Branding**: app name (e.g. *Agent Command Center*), your email as support and developer contact.
2. **Audience**: user type **External**, publishing status **Testing**. Under *Test users*, add your own Google account.
3. **Data access** (optional while testing): add the scopes above (`gmail.readonly`, `calendar.events.readonly`, and `gmail.compose` if you use drafts).

You don't need to submit for verification: in *Testing* mode only the test users you list can sign in.

## 3. Create the OAuth client

1. **Clients → Create client** → application type **Web application**.
2. **Authorized redirect URIs** → add exactly:
   `http://127.0.0.1:3000/api/oauth/google/callback`
3. Create, then copy the **Client ID** and **Client secret**.

## 4. Add them to `.env.local`

```
GOOGLE_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<your-client-secret>
```

Restart the app (`npm run build && npm run start`, or `npm run dev`). If the scheduler worker runs as a service, restart it too, because it reads `.env.local` only when it starts and it's the process that syncs Google for scheduled briefings:

```bash
systemctl --user restart agent-command-center-worker
```

Open the app at **http://127.0.0.1:3000**, not `localhost`, because the redirect URI must match exactly.

## 5. Connect

1. **Connections & Permissions** → *Gmail* → **Connect with Google**.
2. Google shows *"Google hasn't verified this app"*. This is expected for your own app in Testing mode. Choose *Continue*.
3. Approve the single read-only permission. If Google grants anything missing or broader than requested, the app revokes it and connects nothing.
4. Back in the dashboard, set the service to **Read**, then give **Read** to the agent that should use it (*Inbox* for Gmail, *Calendar* for Google Calendar).
5. Click **Sync now**, or let the morning briefing sync it.

Repeat for Google Calendar.

**Gmail drafts (optional):** connect it the same way, then:
- set the **Gmail drafts** service to **Write with approval**;
- give the **Follow-up** agent **Write with approval** on Gmail drafts **and Read on Gmail** (it needs to see what's waiting on you).

The morning briefing and the Friday sweep then propose reply drafts for unread personal mail. You can also ask <kbd>Ctrl</kbd>+<kbd>K</kbd> “draft reply to Ana: Friday works!”. Each proposal waits in the Action Queue; edit the text, approve, and it appears in Gmail Drafts, in the right thread. If you added scopes on the consent screen's *Data access* page, add `gmail.compose` there too.

**Google Calendar: app calendar (optional):** lets Ctrl+K “add event: dentist tuesday 3pm” add the event itself, after one click on **Approve and add to calendar**. Connect it the same way, then:
- set the **Google Calendar: app calendar** service to **Write with approval**;
- give the **Calendar** agent **Write with approval** on it.

The first approved event creates the “Agent Command Center” calendar, which appears next to your own in Google Calendar. Disconnecting keeps that calendar and its events in your account. If you'd rather add events yourself, choose “I add it myself” in Settings → Calendar events: the app then only opens Google's pre-filled page. If you added scopes on the *Data access* page, add `calendar.app.created` there too.

## Good to know

- **Weekly re-consent:** while the app is in Testing mode, Google expires refresh tokens after 7 days. When that happens, the app shows the service as revoked; click *Connect with Google* again.
- **Where tokens live:** tokens are encrypted (AES-256-GCM) in the local database. The key is in `~/.config/agent-command-center/token.key` (mode 0600), outside the project. Anyone who can read files as your OS user could read both. An OS keyring is the next hardening step.
- **Disconnect:** *Disconnect & revoke* revokes the token at Google, deletes it, and deletes everything synced from that service. You can also revoke access at <https://myaccount.google.com/permissions>; the app notices on its next sync.
- **No email is ever sent by the app:** the only write path to Google is creating an approved draft (if you connect Gmail drafts). Sending stays your click, in Gmail.
