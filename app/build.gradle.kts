plugins {
    alias(libs.plugins.android.application)
    // No kotlin-android plugin: AGP 9.0+ provides Kotlin support built in and
    // rejects the standalone plugin. See kotl.in/gradle/agp-built-in-kotlin.
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "ir.rhinocloud.easyotp"
    // 36 is the newest platform installable from the stable SDK channel; 37 is
    // catalogued but not published there yet. Dependency versions are pinned to
    // match in gradle/libs.versions.toml.
    compileSdk = 36

    defaultConfig {
        // Host and Receiver are separate apps that can sit on one phone, so each
        // has its own id. An id is permanent once a phone has installed it.
        applicationId = "ir.rhinocloud.easyotp.host"
        // API 26 is the floor for TelephonyManager.sendUssdRequest, which M2 needs
        // for balance and package checks -- the feature that keeps a remote SIM alive.
        minSdk = 26
        targetSdk = 36
        // CI passes both; a local build is always 1 / dev.
        versionCode = System.getenv("EASYOTP_VERSION_CODE")?.toIntOrNull() ?: 1
        versionName = System.getenv("EASYOTP_VERSION_NAME") ?: "0.1.0-dev"
    }

    // The release key exists only in CI (DECISIONS D20). Without it a release
    // build is left unsigned instead of falling back to a debug key, so an APK
    // that installs was necessarily signed with the real one.
    val releaseKeystore = System.getenv("EASYOTP_KEYSTORE")
    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storeType = "pkcs12"
                storePassword = System.getenv("EASYOTP_KEYSTORE_PASSWORD")
                keyAlias = "easyotp"
                keyPassword = System.getenv("EASYOTP_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures { compose = true }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.service)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)

    // HPKE (RFC 9180). The platform has no X25519 before API 33 and this app
    // supports 26, so the suite has to come from a library.
    implementation(libs.tink.android)

    testImplementation(libs.junit)
    testImplementation(libs.json)
}
