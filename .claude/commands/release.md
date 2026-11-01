Cut a patch release of Switchboard: bump the version, tag it, let CI build it, then publish the draft with notes.

1. Look up the last release tag (`git describe --tags --abbrev=0`) and read every commit since it, bodies included: `git log <last tag>..HEAD --format="%B---"`.
2. Raise the patch version without letting npm tag: `npm version patch --no-git-tag-version`.
3. Commit the bump as `v<version>: <one-line summary of what changed>`.
4. Tag that commit `v<version>`.
5. Push the commit and the tag: `git push && git push --tags`.
6. The tag starts the "Package and release" workflow. Follow its newest run with `gh run watch` until it finishes.
7. The run leaves a draft release. Check it carries the DMG, the zip and `Switchboard-<version>.apk`. The APK only gets built when all four signing secrets are set (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`); without them the run leaves a notice instead, and you say the APK is missing. Then publish the draft with its notes: `gh release edit v<version> --draft=false --notes "..."`.
8. Lay the notes out like this, one heading per kind of change (say Features, Bug Fixes, Performance Improvements):

    ```
    ## What's Changed

    ### <kind of change>
    - <entry>

    ### <kind of change>
    - <entry>
    ```

## What goes in the notes

The reader is someone who uses the app, not someone who reads its history. Go through all the commits so nothing they would notice slips through, but don't retell the commits one by one: say what is different for them.

An entry describes what the user sees: how the app behaved before and how it behaves now. It never names code, database columns, migrations or files.

Skip:

- **Fixes to bugs that appeared after the last tag.** Nobody ran the broken version, so there is nothing to tell. Describe where things stand compared with the last release.
- Refactors, migrations, test changes and tooling that change nothing the user can see.
- Visual nudges too small to spot, like a bit of padding, a font size or a shade of colour.
- **Anything nobody has seen working.** If a change is untested or known to be broken, bring it up before publishing rather than announcing it.

A feature and the fixes that followed it are one entry, describing how it ended up. Often several commits make one change the user notices, and sometimes one commit makes several.

Three entries that matter are better than twelve that pad. When nothing changed for the user, the notes say exactly that.
