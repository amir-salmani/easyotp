plugins {
    // No Kotlin plugin: AGP 9 provides Kotlin support built in and rejects the
    // standalone one. See kotl.in/gradle/agp-built-in-kotlin.
    alias(libs.plugins.android.application)
}

android {
    namespace = "ir.rhinocloud.easyotp"
    // Compiling against 37 only makes its APIs visible. The behaviour the
    // phone applies follows targetSdk, which stays at 36 until the service has
    // been proven on a real device running 37.
    compileSdk = 37

    defaultConfig {
        // Host and Receiver are separate apps that can sit on one phone, so each
        // has its own id. An id is permanent once a phone has installed it.
        applicationId = "ir.rhinocloud.easyotp.host"
        // API 26 is the floor for TelephonyManager.sendUssdRequest, which checking
        // a remote SIM's balance will need.
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

    lint {
        // Both object to requiring telephony, because Chrome OS has none. The
        // Host is an app for a phone with a SIM in it, and nothing else.
        disable += setOf("PermissionImpliesUnsupportedChromeOsHardware", "UnsupportedChromeOsHardware")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

}

dependencies {
    implementation(project(":shell"))
    implementation(libs.tink.android)

    testImplementation(libs.junit)
    testImplementation(libs.json)
}

// The screens are built from receiver/ and are not in git. An APK without them
// would install and show a blank window, so the build stops here instead.
run {
    // Locals only: a task action that reaches for the build script cannot be cached.
    val screens = layout.projectDirectory.file("src/main/assets/ui/host.html").asFile
    val missing = "The screens are missing. Run `npm run build:host` in receiver/ first."
    tasks.named("preBuild") {
        doFirst {
            if (!screens.exists()) throw GradleException(missing)
        }
    }
}
