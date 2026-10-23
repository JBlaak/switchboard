plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// The app ships with each Switchboard release (#208), so its version is the
// Mac app's: read from the repository's package.json.
val switchboardVersion: String = run {
    val packageJson = rootProject.layout.projectDirectory.file("../package.json")
    val text = providers.fileContents(packageJson).asText.orNull
        ?: throw GradleException("Can't read ${packageJson.asFile}: the app's version comes from Switchboard's package.json")
    Regex("\"version\"\\s*:\\s*\"([^\"]+)\"").find(text)?.groupValues?.get(1)
        ?: throw GradleException("No \"version\" in ${packageJson.asFile}")
}

// 2.8.1 -> 20801. Each part has to stay below 100 for the codes to keep rising.
val switchboardVersionCode: Int = run {
    val parts = Regex("^(\\d+)\\.(\\d+)\\.(\\d+)").find(switchboardVersion)?.destructured
        ?: throw GradleException("Switchboard's version \"$switchboardVersion\" isn't major.minor.patch")
    val (major, minor, patch) = parts.toList().map(String::toInt)
    if (minor >= 100 || patch >= 100) {
        throw GradleException("Switchboard's version \"$switchboardVersion\" doesn't fit the versionCode scheme")
    }
    major * 10000 + minor * 100 + patch
}

// Release signing comes from the environment (the release workflow's
// secrets). Without it, assembleRelease still builds, unsigned.
val releaseKeystorePath: String? = providers.environmentVariable("ANDROID_KEYSTORE_PATH").orNull
val releaseKeystorePassword: String? = providers.environmentVariable("ANDROID_KEYSTORE_PASSWORD").orNull
val releaseKeyAlias: String? = providers.environmentVariable("ANDROID_KEY_ALIAS").orNull
val releaseKeyPassword: String? = providers.environmentVariable("ANDROID_KEY_PASSWORD").orNull
val signsRelease = listOf(releaseKeystorePath, releaseKeystorePassword, releaseKeyAlias, releaseKeyPassword)
    .all { !it.isNullOrEmpty() }

android {
    namespace = "dev.jblaak.switchboard"
    compileSdk = 37

    defaultConfig {
        applicationId = "dev.jblaak.switchboard"
        minSdk = 30
        targetSdk = 36
        versionCode = switchboardVersionCode
        versionName = switchboardVersion
    }

    signingConfigs {
        if (signsRelease) {
            create("release") {
                storeFile = file(releaseKeystorePath!!)
                storePassword = releaseKeystorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            // R8 stays off: the WebView JS bridge, kotlinx.serialization and
            // ML Kit would each need keep rules checked on a device first.
            isMinifyEnabled = false
            if (signsRelease) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

kotlin {
    jvmToolchain(21)
}

dependencies {
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.biometric)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.webkit)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.mlkit.barcode.scanning)
    implementation(libs.okhttp)
    implementation(libs.patch)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.okhttp.tls)
}
