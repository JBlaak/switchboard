Two loose ends before the release.

### ❓ Q1 - Retry failed webhooks: Partners see gaps when their endpoint is down for a minute.

➡️ Retry three times with backoff, then park it in a dead-letter table.

***

❓ **Q3.** **Log the payload?**: Payloads can carry personal data.

➡️ Log the event id and status only.

___

❓ **Q4:** Alert on parking: Someone should hear about a parked webhook.

➡️ A daily digest, not a page.

❓ 5 — Expose a replay button: Support asks for it weekly.

➡️ Yes, admin-only.
