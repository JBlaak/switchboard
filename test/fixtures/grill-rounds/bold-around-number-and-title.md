❓ **Q1 - Cache the search index?**: Rebuilding takes four seconds at startup.

➡️ Yes, cache it on disk and rebuild when the schema version changes.

---

❓ **Q2 - Which hashing scheme?:**
➡️ Content hash of the schema file; the version number is often forgotten.
