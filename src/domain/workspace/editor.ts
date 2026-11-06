/**
 * Which IDE a working directory opens in (#342).
 *
 * Decided from what is at the folder's top level, so it is a pure function of
 * a listing: Android before PHP/Node before Python, and Sublime Text for
 * anything else. Telling an Android Gradle project from any other Gradle one
 * takes a look past the top level, at the app module's manifest or at the
 * Android Gradle plugin named in a build script, so the listing carries those
 * too.
 *
 * When the matching app is missing, the editor falls back to Sublime Text and
 * then to a Finder window (`editorFallbacks`).
 */

/** An IDE the Editor action can open. */
export type Editor = 'android-studio' | 'phpstorm' | 'pycharm' | 'sublime-text';

/** What `open -a` is given for each editor: the app bundle's name. */
export const EDITOR_APPS: Readonly<Record<Editor, string>> = {
    'android-studio': 'Android Studio',
    phpstorm: 'PhpStorm',
    pycharm: 'PyCharm',
    'sublime-text': 'Sublime Text',
};

/** What a folder holds, as far as choosing its editor needs. */
export interface FolderListing {
    /** The names of the folder's top-level entries, files and directories alike. */
    topLevel: readonly string[];
    /**
     * Whether an Android module's manifest is there
     * (`app/src/main/AndroidManifest.xml` or the like).
     */
    androidManifest: boolean;
    /**
     * The text of the Gradle files that can name the Android plugin: the
     * top-level build and settings scripts and `gradle/libs.versions.toml`,
     * keyed by their path relative to the folder. Missing ones are left out.
     */
    gradleFiles: Readonly<Record<string, string>>;
}

/** The top-level files that make a folder a Gradle build. */
export const GRADLE_MARKERS = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'] as const;

/** The Gradle files whose text is read for the Android plugin, relative to the folder. */
export const GRADLE_SCRIPTS = [...GRADLE_MARKERS, 'gradle/libs.versions.toml'] as const;

/** Where an Android module's manifest is looked for, relative to the folder. */
export const ANDROID_MANIFESTS = ['app/src/main/AndroidManifest.xml', 'src/main/AndroidManifest.xml'] as const;

const PHP_OR_NODE_MARKERS = ['composer.json', 'package.json'];
const PYTHON_MARKERS = ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'];

/**
 * The Android Gradle plugin, however a build names it: its plugin ids
 * (`com.android.application`, `com.android.library`), its classpath artifact
 * (`com.android.tools.build:gradle`) or a version-catalog alias
 * (`libs.plugins.android.application`).
 */
const ANDROID_PLUGIN = /com\.android\.(application|library|tools\.build)|libs\.plugins\.android[.-]/;

/** The editor that matches a folder. */
export function detectEditor(listing: FolderListing): Editor {
    const names = new Set(listing.topLevel);
    if (isAndroidProject(listing, names)) return 'android-studio';
    if (PHP_OR_NODE_MARKERS.some((name) => names.has(name))) return 'phpstorm';
    if (PYTHON_MARKERS.some((name) => names.has(name))) return 'pycharm';
    return 'sublime-text';
}

function isAndroidProject(listing: FolderListing, names: ReadonlySet<string>): boolean {
    if (!GRADLE_MARKERS.some((name) => names.has(name))) return false;
    if (listing.androidManifest) return true;
    return Object.values(listing.gradleFiles).some((text) => ANDROID_PLUGIN.test(text));
}

/**
 * The editors to try, in order, for a folder that matches `editor`: the match
 * itself, then Sublime Text. After these comes a Finder window.
 */
export function editorFallbacks(editor: Editor): Editor[] {
    return editor === 'sublime-text' ? ['sublime-text'] : [editor, 'sublime-text'];
}

/** The terminal apps Shell here tries, in order: iTerm when installed, else Terminal. */
export const SHELL_APPS = ['iTerm', 'Terminal'] as const;
