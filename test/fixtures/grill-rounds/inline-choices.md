❓ **Q1** - **How long to keep a deleted project?**: Only the database row and its uploads cost space. (a) Forever; (b) 30 days, then purge; (c) Until an admin empties the bin. Admins rarely empty anything by hand.

➡️ (b) 30 days, then purge: predictable, and support can still restore within the month.

---

❓ **Q2** - **Which queue?**: Pick the transport:

- (a) Postgres with SKIP LOCKED
- (b) Redis streams

➡️ (a), no new service to run.

---

❓ **Q3** - **Sort order?**: Either a) newest first, b) by name, or c) by size.

➡️ **a)** Newest first, as the old screen did.
