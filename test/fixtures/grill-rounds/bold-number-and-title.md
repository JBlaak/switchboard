Settled last round: uploads go straight to object storage, no local staging.

---

❓ **Q1** - **Resize images on upload?**: Thumbnails are built on every page view today.
Doing it once on upload moves that cost to a background job.

➡️ Yes: resize on upload, keep the original next to it.

---

❓ **Q2** - **Where do the thumbnails live?**: Next to the original or in a bucket of their own.

➡️ Next to the original, under a `thumbs/` prefix.

---

❓ **Q3** - **Keep the old image route?**: Two mobile clients still call it.

➡️ Keep it for one more release, then drop it.
